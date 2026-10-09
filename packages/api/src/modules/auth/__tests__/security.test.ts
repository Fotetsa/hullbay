import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { scryptSync, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { generateSecret, generateSync } from "otplib";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { registerAuthGuard, registerAuthRoutes } from "../routes";
import { authService, AuthError } from "../service";
import { authRateLimiter } from "../rate-limit";
import { prisma } from "../../../lib/prisma";
import { encryptSecret } from "../crypto";
import { registerDeploySubscribers } from "../../../subscribers/on-deploy-finished";
import { jwksService } from "../jwks/jwks.service";

// Tests SÉCURITÉ du module auth (true service, prisma mocké) :
// rate-limiting composé, anti-énumération, cloisonnement des audiences JWT et
// alimentation du journal d'audit.
//
// Les credentials vivent sur AuthIdentity(local) — on mocke donc
// prisma.authIdentity (plus prisma.user) comme lookup de connexion.

vi.mock("../../../lib/prisma", () => {
  const authIdentity = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(() => Promise.resolve({})),
    create: vi.fn(),
  };
  const user = {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
  };
  const tenant = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  };
  const membership = {
    create: vi.fn(),
    updateMany: vi.fn(),
  };
  const auditLog = {
    create: vi.fn(() => Promise.resolve({ id: "audit-1" })),
    findMany: vi.fn(),
    count: vi.fn(),
  };
  return {
    prisma: {
      authIdentity,
      user,
      tenant,
      membership,
      auditLog,
      pendingIdentity: { upsert: vi.fn(), create: vi.fn() },
      systemInfo: { upsert: vi.fn() },
    },
  };
});

const SECRET = "security-test-secret";

const PASSWORD = "F12345678";
const SALT = "00112233445566778899aabbccddeeff";
const PASSWORD_HASH = `${SALT}:${scryptSync(PASSWORD, SALT, 64).toString("hex")}`;

// AuthIdentity(local) : les credentials sont portés par l'identité.
const IDENTITY_USER = {
  id: "i-1",
  userId: "u-1",
  providerId: "local",
  kind: "local",
  issuer: null,
  subject: "local:u-1",
  email: "alice@hullbay.local",
  passwordHash: PASSWORD_HASH,
  mfaEnabled: false,
  mfaSecretEnc: null,
  createdAt: new Date(),
  lastLoginAt: null,
  user: { id: "u-1", role: "owner" },
};

const IDENTITY_MFA_USER = {
  id: "i-2",
  userId: "u-2",
  providerId: "local",
  kind: "local",
  issuer: null,
  subject: "local:u-2",
  email: "bob@hullbay.local",
  passwordHash: PASSWORD_HASH,
  mfaEnabled: true,
  mfaSecretEnc: "", // rempli dans beforeAll (dépend de l'env MFA_ENCRYPTION_KEY)
  createdAt: new Date(),
  lastLoginAt: null,
  user: { id: "u-2", role: "operator" },
};

/** Row User minimale — utilisée par les chemins qui lisent le rôle après MFA. */
const USER_ROW = { id: "u-2", role: "operator" };

const inject = (app: FastifyInstance, url: string, opts: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url, ...opts });

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Forme du 1er argument de `prisma.auditLog.create(data)` côté subscriber. */
type AuditCreateArg = {
  data: {
    action: string
    userId: string | null
    payload: Record<string, unknown>
  }
}

const auditCalls = () =>
  vi.mocked(prisma.auditLog.create).mock.calls as Array<[AuditCreateArg]>;
const auditCallBy = (action: string) =>
  auditCalls().find(([arg]) => arg.data.action === action);

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.MFA_ENCRYPTION_KEY = "";
  IDENTITY_MFA_USER.mfaSecretEnc = encryptSecret(generateSecret({ length: 20 }));
  // Enregistre l'audit événementiel (écrit dans AuditLog via prisma mocké).
  registerDeploySubscribers();
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.MFA_ENCRYPTION_KEY;
});

describe("Auth hardening", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp({
      routes: async (app) => {
        registerAuthGuard(app);
        await registerAuthRoutes(app);
      },
    });
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() retire les implémentations mock (retourne undefined) :
    // le subscriber d'audit appelle prisma.auditLog.create().catch() — il faut
    // que .create() retourne un promesse pour que .catch() soit appelable.
    vi.mocked(prisma.auditLog.create).mockResolvedValue({ id: "audit-1" } as never);
    authRateLimiter.clear();
  });

  describe("rate limiting (brute-force)", () => {
    it("bloque à la 6e tentative de login échouée (429 + Retry-After)", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(null as never);

      for (let i = 1; i <= 5; i++) {
        const res = await inject(app, "/api/auth/login", {
          payload: { email: "target@hullbay.local", password: "wrong-pass" },
        });
        expect(res.statusCode).toBe(401);
      }

      const sixth = await inject(app, "/api/auth/login", {
        payload: { email: "target@hullbay.local", password: "wrong-pass" },
      });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json()).toMatchObject({ code: "rate_limited" });
      expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("ne bloque pas un autre compte sur la même IP", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(null as never);

      for (let i = 1; i <= 5; i++) {
        await inject(app, "/api/auth/login", {
          payload: { email: "blocked@hullbay.local", password: "wrong-pass" },
        });
      }

      const other = await inject(app, "/api/auth/login", {
        payload: { email: "other@hullbay.local", password: "wrong-pass" },
      });
      expect(other.statusCode).toBe(401);
    });

    it("ne bloque pas depuis une autre IP sur le même compte", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(null as never);

      for (let i = 1; i <= 5; i++) {
        await inject(app, "/api/auth/login", {
          remoteAddress: "198.51.100.7",
          payload: { email: "bypass@hullbay.local", password: "wrong-pass" },
        });
      }

      const otherIp = await inject(app, "/api/auth/login", {
        remoteAddress: "198.51.100.8",
        payload: { email: "bypass@hullbay.local", password: "wrong-pass" },
      });
      expect(otherIp.statusCode).toBe(401);
    });

    it("un login réussi remet le compteur à zéro", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(IDENTITY_USER as never);

      const fail = () =>
        inject(app, "/api/auth/login", {
          payload: { email: IDENTITY_USER.email, password: "wrong-pass" },
        });

      // 4 échecs puis succès : le compteur est purgé (on reste sous le seuil).
      for (let i = 1; i <= 4; i++) expect((await fail()).statusCode).toBe(401);
      expect((await inject(app, "/api/auth/login", {
        payload: { email: IDENTITY_USER.email, password: PASSWORD },
      })).statusCode).toBe(200);

      // Nouveau cycle de 4 échecs puis succès : toujours 200. Si le compteur
      // n'avait PAS été purgé, on serait bloqué (8 échecs cumulés > 5).
      for (let i = 1; i <= 4; i++) expect((await fail()).statusCode).toBe(401);
      expect((await inject(app, "/api/auth/login", {
        payload: { email: IDENTITY_USER.email, password: PASSWORD },
      })).statusCode).toBe(200);
    });
  });

  describe("anti-énumération", () => {
    it("réponse identique que le compte existe ou non (même statut + même corps)", async () => {
      vi.mocked(prisma.authIdentity.findFirst) // identité INEXISTANTE
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(IDENTITY_USER as never) // identité EXISTANTE, mauvais mot de passe
        .mockResolvedValueOnce(IDENTITY_USER as never);

      const missing = await inject(app, "/api/auth/login", {
        payload: { email: "ghost@hullbay.local", password: "wrong-pass" },
      });
      const missing2 = await inject(app, "/api/auth/login", {
        payload: { email: "ghost@hullbay.local", password: "wrong-pass2" },
      });
      const existing = await inject(app, "/api/auth/login", {
        payload: { email: IDENTITY_USER.email, password: "wrong-pass" },
      });
      const existing2 = await inject(app, "/api/auth/login", {
        payload: { email: IDENTITY_USER.email, password: "wrong-pass2" },
      });

      expect(missing.statusCode).toBe(401);
      expect(existing.statusCode).toBe(401);
      expect(missing.json()).toEqual(existing.json());
      expect(missing2.json()).toEqual(existing2.json());
      expect(missing.json()).toEqual({
        error: "identifiants invalides",
        code: "invalid_credentials",
      });
    });
  });

  describe("cloisonnement des audiences JWT", () => {
    it("un token mfa-pending n'est jamais accepté comme session", () => {
      const pending = jwt.sign(
        { sub: "u-1", mfa: "pending" },
        SECRET,
        { expiresIn: "5m", audience: "mfa-pending" },
      );
      expect(() => authService.verifyToken(pending)).toThrow();
    });

    it("un token de session n'est jamais accepté comme pendingToken MFA", async () => {
      const session = jwt.sign(
        { sub: "u-1", role: "owner", mfaEnabled: true },
        SECRET,
        { expiresIn: "12h", audience: "session" },
      );
      await expect(authService.verifyMfa(session, "123456")).rejects.toMatchObject({
        code: "mfa_token_invalid",
      });
    });

    it("rejette un code MFA invalide (audience valide)", async () => {
      const pending = jwt.sign(
        { sub: IDENTITY_MFA_USER.userId, mfa: "pending", tenantId: "tenant-default" },
        SECRET,
        { expiresIn: "5m", audience: "mfa-pending" },
      );
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(IDENTITY_MFA_USER as never);

      await expect(authService.verifyMfa(pending, "000000")).rejects.toMatchObject({
        code: "mfa_code_invalid",
      });
    });
  });

  describe("expiration et état des tokens", () => {
    it("rejette un pendingToken MFA expiré (401 mfa_token_invalid)", async () => {
      const expired = jwt.sign(
        { sub: IDENTITY_MFA_USER.userId, mfa: "pending" },
        SECRET,
        { expiresIn: "-1s", audience: "mfa-pending" },
      );
      await expect(authService.verifyMfa(expired, "123456")).rejects.toMatchObject({
        code: "mfa_token_invalid",
      });
    });

    it("rejette un token de session expiré", () => {
      const expired = jwt.sign(
        { sub: "u-1", role: "owner", mfaEnabled: true },
        SECRET,
        { expiresIn: "-1s", audience: "session" },
      );
      expect(() => authService.verifyToken(expired)).toThrow();
    });

    it("rejette un token de session sans rôle (état invalide)", () => {
      const noRole = jwt.sign({ sub: "u-1" }, SECRET, {
        expiresIn: "12h",
        audience: "session",
      });
      expect(() => authService.verifyToken(noRole)).toThrow();
    });
  });

  describe("journal d'audit", () => {
    it("journalise auth.login.failed sur un échec de connexion", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(null as never);
      const res = await inject(app, "/api/auth/login", {
        payload: { email: "audit@hullbay.local", password: "wrong-pass" },
      });
      expect(res.statusCode).toBe(401);
      await flush();

      const call = auditCalls().at(-1);
      expect(call).toBeDefined();
      const data = call![0].data;
      expect(data.action).toBe("auth.login.failed");
      expect(data.userId).toBeNull();
    });

    it("journalise auth.login.success sur une connexion réussie", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(IDENTITY_USER as never);
      const res = await inject(app, "/api/auth/login", {
        payload: { email: IDENTITY_USER.email, password: PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      await flush();

      const call = auditCallBy("auth.login.success");
      expect(call).toBeDefined();
      expect(call![0].data.userId).toBe(IDENTITY_USER.userId);
    });

    it("journalise auth.mfa.failed sur un code TOTP invalide", async () => {
      const pending = jwt.sign(
        { sub: IDENTITY_MFA_USER.userId, mfa: "pending", tenantId: "tenant-default" },
        SECRET,
        { expiresIn: "5m", audience: "mfa-pending" },
      );
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(IDENTITY_MFA_USER as never);

      await expect(authService.verifyMfa(pending, "000000")).rejects.toBeInstanceOf(AuthError);
      await flush();

      expect(auditCallBy("auth.mfa.failed")).toBeDefined();
    });

    it("journalise auth.mfa.success sur un code TOTP valide", async () => {
      const secret = generateSecret({ length: 20 });
      IDENTITY_MFA_USER.mfaSecretEnc = encryptSecret(secret);
      const pending = jwt.sign(
        { sub: IDENTITY_MFA_USER.userId, mfa: "pending", tenantId: "tenant-default" },
        SECRET,
        { expiresIn: "5m", audience: "mfa-pending" },
      );
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(IDENTITY_MFA_USER as never);
      vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue(USER_ROW as never);

      const result = await authService.verifyMfa(pending, generateSync({ secret }));
      expect(result.token).toBeTruthy();
      await flush();

      const call = auditCallBy("auth.mfa.success");
      expect(call).toBeDefined();
      expect(call![0].data.userId).toBe(IDENTITY_MFA_USER.userId);
    });

    it("journalise auth.password.changed sur un changement de mot de passe", async () => {
      vi.mocked(prisma.authIdentity.findFirst).mockResolvedValue(IDENTITY_USER as never);
      vi.mocked(prisma.authIdentity.update).mockResolvedValue(IDENTITY_USER as never);

      await authService.changePassword(IDENTITY_USER.userId, PASSWORD, "F12345677");
      await flush();

      const call = auditCallBy("auth.password.changed");
      expect(call).toBeDefined();
      expect(call![0].data.userId).toBe(IDENTITY_USER.userId);
    });

    it("journalise auth.tenant_forbidden sur un rejet cross-tenant (rôle legacy ignoré)", async () => {
      // Token stale signé owner sur tenant-défaut, mais aucun membership en base
      // pour tenant-b → resolveRoleForUser FAIL-CLOSED à "viewer" (#170).
      const stale = jwksService.signPayload(
        { sub: "u-2", role: "operator", mfaEnabled: true, jti: randomUUID(), tenantId: "tenant-default" },
        { expiresIn: 43200, audience: "session" },
      );

      const res = await app.inject({
        method: "GET",
        url: "/api/users",
        headers: { authorization: `Bearer ${stale}`, "x-tenant-id": "tenant-b" },
      });
      expect(res.statusCode).toBe(403);
      await flush();

      const call = auditCallBy("auth.tenant_forbidden");
      expect(call).toBeDefined();
      expect(call![0].data.userId).toBe("u-2");
      expect(call![0].data.payload).toMatchObject({
        tenantId: "tenant-b",
        requiredRole: "owner",
        effectiveRole: "viewer",
      });
    });
  });
});