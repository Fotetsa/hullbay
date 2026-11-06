import { describe, it, expect, vi, beforeAll } from "vitest";
import Fastify, { FastifyRequest } from "fastify";
import { createAuthorization } from "../authorization.service";
import {
  MemoryGrantRepository,
  MemoryResourceRepository,
} from "../repositories/memory";
import { VIEWER_KEYS, OPERATOR_KEYS, OWNER_KEYS } from "./preset-matrix";

const holder = vi.hoisted(() => ({
  mode: "legacy" as "legacy" | "shadow" | "enforce",
  authorization: null as any,
  logs: [] as Record<string, unknown>[],
}));

vi.mock("../http", async () => {
  const { createRequirePermission } =
    await import("../http/require-permission");
  const { evaluateLegacyRole } = await import("../../auth/authorization/rbac");
  const resolvers = await import("../http/resolvers");
  return {
    requirePermission: createRequirePermission({
      authorization: () => holder.authorization,
      mode: () => holder.mode,
      evaluateLegacy: evaluateLegacyRole,
      log: (level, entry) => holder.logs.push({ level, ...entry }),
    }),
    fromParam: resolvers.fromParam,
    fromBody: resolvers.fromBody,
    fromBodyIfPresent: resolvers.fromBodyIfPresent,
  };
});

// Les utilisateurs de ces tests n'existent pas en base : on rend le rôle du token.
vi.mock("../../auth/identity/auth-identity.service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../auth/identity/auth-identity.service")
    >();
  return {
    ...actual,
    resolveRoleForUser: async (_u: string, _t: string, fallback: string) =>
      fallback,
  };
});

import { registerAuthRoutes } from "../../auth/routes/auth.routes";
import { registerProvidersRoutes } from "../../auth/routes/providers.routes";
import { registerPendingRoutes } from "../../auth/routes/pending.routes";
import { registerRegistryRoutes } from "../../registry/routes";
import { registerSettingsRoutes } from "../../settings/routes";
import { registerUpdatesRoutes } from "../../updates/routes";

const T1 = "t1";
const preset = (id: string, name: string, keys: string[]) => ({
  id,
  tenantId: T1,
  name,
  isSystem: false,
  isPreset: true,
  permissions: keys.map((key) => ({ key, scopeType: "tenant", scopeId: T1 })),
});
// Rôle personnalisé : créé comme donnée, aucun code modifié.
const auditor = {
  id: "r-aud",
  tenantId: T1,
  name: "Security Auditor",
  isSystem: false,
  permissions: [
    { key: "audit.read", scopeType: "tenant", scopeId: T1 },
    { key: "provider.read", scopeType: "tenant", scopeId: T1 },
  ],
};
const ROLES = ["viewer", "operator", "owner"] as const;

const captured: { method: string; url: string; guarded: boolean }[] = [];
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  holder.authorization = createAuthorization({
    grants: new MemoryGrantRepository({
      memberships: [
        ...ROLES.map((r) => ({
          id: `m-${r}`,
          userId: `u-${r}`,
          tenantId: T1,
          legacyRole: r,
          roleId: null,
        })),
        {
          id: "m-aud",
          userId: "u-aud",
          tenantId: T1,
          legacyRole: "",
          roleId: "r-aud",
        },
      ],
      roles: [
        preset("rv", "Viewer", VIEWER_KEYS),
        preset("ro", "Operator", OPERATOR_KEYS),
        preset("rw", "Owner", OWNER_KEYS),
        auditor,
      ],
      teamMembers: [],
      teamRoles: [],
    }),
    resources: new MemoryResourceRepository([]),
  });
  app = Fastify({ logger: false });
  app.addHook("onRoute", (route: any) => {
    const guarded = ([] as any[])
      .concat(route.preHandler ?? [])
      .some((h) => h?.authzAction);
    for (const m of ([] as string[]).concat(route.method)) {
      if (m !== "HEAD") captured.push({ method: m, url: route.url, guarded });
    }
    route.handler = async () => ({ ok: true });
    delete route.schema;
  });
  app.addHook("onRequest", async (req: FastifyRequest) => {
    const h = req.headers;
    (req as any).user = {
      sub: h["x-user"],
      role: h["x-role"],
      mfaEnabled: true,
      tenantId: T1,
    };
    (req as any).tenantId = T1;
  });
  await registerAuthRoutes(app); // users + audit + routes de libre-service
  await registerProvidersRoutes(app);
  await registerPendingRoutes(app);
  await registerRegistryRoutes(app);
  await registerSettingsRoutes(app);
  await registerUpdatesRoutes(app);
  await app.ready();
}, 120000);

const guardedRoutes = () => captured.filter((r) => r.guarded);
const fill = (url: string) => url.replace(/:([A-Za-z]+)/g, "x");

async function call(
  mode: typeof holder.mode,
  r: { method: string; url: string },
  user: string,
  role: string,
) {
  holder.mode = mode;
  const res = await app.inject({
    method: r.method as any,
    url: fill(r.url),
    headers: { "x-user": user, "x-role": role },
    payload: ["POST", "PUT", "PATCH"].includes(r.method) ? {} : undefined,
  });
  return res.statusCode;
}

const isAudit = (r: { url: string }) => r.url === "/api/audit";

describe("Lot D : administration", () => {
  it("29 routes gardées ; les routes de libre-service d'authentification restent sans permission", () => {
    expect(guardedRoutes()).toHaveLength(29);
    const open = captured.filter((r) => !r.guarded).map((r) => r.url);
    for (const url of open) expect(url).toMatch(/^\/api\/auth\//);
    expect(open).not.toContain("/api/audit");
  });

  it("mêmes codes en legacy, shadow et enforce, aucune divergence", async () => {
    const mismatches: string[] = [];
    for (const route of guardedRoutes()) {
      for (const role of ROLES) {
        holder.logs.length = 0;
        const legacy = await call("legacy", route, `u-${role}`, role);
        const shadow = await call("shadow", route, `u-${role}`, role);
        const logged = holder.logs.length;
        const enforce = await call("enforce", route, `u-${role}`, role);
        if (legacy !== shadow || legacy !== enforce || logged > 0) {
          mismatches.push(
            `${route.method} ${route.url} [${role}] ${legacy}/${shadow}/${enforce} div=${logged}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matrice : owner passe partout, operator seulement l'audit, viewer nulle part", async () => {
    for (const route of guardedRoutes()) {
      expect(await call("enforce", route, "u-owner", "owner")).toBe(200);
      expect(await call("enforce", route, "u-operator", "operator")).toBe(
        isAudit(route) ? 200 : 403,
      );
      expect(await call("enforce", route, "u-viewer", "viewer")).toBe(403);
    }
  });

  it("anti-verrouillage : le preset Owner passe les 29 routes en enforce", async () => {
    for (const route of guardedRoutes()) {
      expect(await call("enforce", route, "u-owner", "owner")).toBe(200);
    }
  });

  it("rôle « Security Auditor » créé comme donnée : lit l'audit et les providers, rien d'autre", async () => {
    const allowed = new Set([
      "GET /api/audit",
      "GET /api/auth/admin/providers",
    ]);
    for (const route of guardedRoutes()) {
      const code = await call("enforce", route, "u-aud", "viewer");
      expect(code).toBe(
        allowed.has(`${route.method} ${route.url}`) ? 200 : 403,
      );
    }
  });
});
