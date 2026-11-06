import { describe, it, expect, vi } from "vitest";
import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import { createAuthorization } from "../authorization.service";
import { createRequirePermission } from "../http/require-permission";
import { fromParam } from "../http/resolvers";
import { resolveMode, type AuthzMode } from "../http/mode";
import {
  MemoryGrantRepository,
  MemoryResourceRepository,
} from "../repositories/memory";
import type { GrantRepository, ResourceRecord } from "../engine/types";


vi.setConfig({ hookTimeout: 20000, testTimeout: 20000 });
const T1 = "t1";
const T2 = "t2";

const RESOURCES: ResourceRecord[] = [
  { type: "cluster", id: "cA", tenantId: T1, parents: {} },
  { type: "cluster", id: "cB", tenantId: T1, parents: {} },
  { type: "project", id: "pA", tenantId: T1, parents: { cluster: "cA" } },
  { type: "project", id: "pB", tenantId: T1, parents: { cluster: "cB" } },
  { type: "project", id: "pX", tenantId: T2, parents: {} },
];

// u1 : peut déployer uniquement le projet pA, et lire l'audit sur tout le tenant.
const dev = {
  id: "r1",
  tenantId: T1,
  name: "Dev",
  isSystem: false,
  permissions: [
    { key: "project.deploy", scopeType: "project", scopeId: "pA" },
    { key: "audit.read", scopeType: "tenant", scopeId: T1 },
  ],
};

type Opts = {
  mode: AuthzMode;
  user?: { sub: string; tenantId?: string } | null;
  reqTenantId?: string;
  legacyAllowed?: boolean;
  grants?: GrantRepository;
  legacyRespond?: (min: string) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
};

async function buildApp(o: Opts) {
  const logs: { level: string; entry: Record<string, unknown> }[] = [];
  const memory = new MemoryGrantRepository({
    memberships: [
      { id: "m1", userId: "u1", tenantId: T1, legacyRole: "", roleId: "r1" },
    ],
    roles: [dev],
    teamMembers: [],
    teamRoles: [],
  });
  const grants = o.grants ?? memory;
  const authorization = createAuthorization({
    grants,
    resources: new MemoryResourceRepository(RESOURCES),
  });
  const evaluateLegacy = vi.fn(async () => o.legacyAllowed ?? false);
  const guard = createRequirePermission({
    authorization: () => authorization,
    legacyRespond: o.legacyRespond,
    mode: () => o.mode,
    evaluateLegacy,
    log: (level, entry) => logs.push({ level, entry }),
  });

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const r = req as unknown as { user?: unknown; tenantId?: string };
    if (o.user !== null) r.user = o.user ?? { sub: "u1", tenantId: T1 };
    r.tenantId = o.reqTenantId ?? T1;
  });
  app.post(
    "/projects/:id/deploy",
    {
      preHandler: guard("project.deploy", {
        resource: fromParam("id", "project"),
        legacyMin: "operator",
      }),
    },
    async (req) => ({
      ok: true,
      via: req.authzDecision?.sources[0]?.via ?? null,
    }),
  );
  app.get(
    "/audit",
    { preHandler: guard("audit.read", { legacyMin: "operator" }) },
    async () => ({ ok: true }),
  );
  app.get(
    "/typo",
    { preHandler: guard("nope.nope", { legacyMin: "owner" }) },
    async () => ({ ok: true }),
  );
  await app.ready();
  return { app, logs, evaluateLegacy, memory };
}

const deploy = (app: Awaited<ReturnType<typeof buildApp>>["app"], id: string) =>
  app.inject({ method: "POST", url: `/projects/${id}/deploy` });

describe("garde : authentification et mode legacy", () => {
  it("sans session : 401, quel que soit le mode", async () => {
    for (const mode of ["legacy", "shadow", "enforce"] as const) {
      const { app } = await buildApp({ mode, user: null });
      expect((await deploy(app, "pA")).statusCode).toBe(401);
    }
  });

  it("legacy : le legacy décide et le moteur n'est jamais appelé", async () => {
    const { app, memory, evaluateLegacy } = await buildApp({
      mode: "legacy",
      legacyAllowed: true,
    });
    const spy = vi.spyOn(memory, "findMembership");
    expect((await deploy(app, "pB")).statusCode).toBe(200); // le moteur aurait refusé pB
    expect(spy).not.toHaveBeenCalled();
    expect(evaluateLegacy).toHaveBeenCalled();
    const denied = await buildApp({ mode: "legacy", legacyAllowed: false });
    expect((await deploy(denied.app, "pA")).statusCode).toBe(403);
  });

  it("legacy avec legacyRespond : la réponse et le code viennent de la garde legacy", async () => {
    const { app } = await buildApp({
      mode: "legacy",
      legacyRespond: () => async (_req, reply) =>
        reply.code(403).send({ error: "x", code: "tenant_forbidden" }),
    });
    const res = await deploy(app, "pA");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("tenant_forbidden");
  });
});

describe("garde : enforce", () => {
  it("autorisé : 200, décision attachée à la requête, legacy jamais consulté", async () => {
    const { app, evaluateLegacy } = await buildApp({ mode: "enforce" });
    const res = await deploy(app, "pA");
    expect(res.statusCode).toBe(200);
    expect(res.json().via).toBe("direct");
    expect(evaluateLegacy).not.toHaveBeenCalled();
  });

  it("refusé : 403 sans reason ni sources dans le corps", async () => {
    const { app } = await buildApp({ mode: "enforce" });
    const res = await deploy(app, "pB"); // même tenant, mauvais projet
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "permission insuffisante" });
  });

  it("projet d'un autre tenant et projet inexistant : le même 404", async () => {
    const { app } = await buildApp({ mode: "enforce" });
    const other = await deploy(app, "pX");
    const missing = await deploy(app, "zzz");
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(other.json()).toEqual(missing.json());
  });

  it("action de niveau tenant sans extracteur", async () => {
    const { app } = await buildApp({ mode: "enforce" });
    expect(
      (await app.inject({ method: "GET", url: "/audit" })).statusCode,
    ).toBe(200);
  });

  it("action absente du catalogue : 500 journalisé", async () => {
    const { app, logs } = await buildApp({ mode: "enforce" });
    expect((await app.inject({ method: "GET", url: "/typo" })).statusCode).toBe(
      500,
    );
    expect(logs[0]?.level).toBe("error");
  });

  it("session sans tenant : 401 session_invalid", async () => {
    const { app } = await buildApp({ mode: "enforce", user: { sub: "u1" } });
    const res = await deploy(app, "pA");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("session_invalid");
  });

  it("tenant des données différent du claim de session : refus", async () => {
    const { app, logs } = await buildApp({ mode: "enforce", reqTenantId: T2 });
    const res = await deploy(app, "pA");
    expect(res.statusCode).toBe(403);
    expect(logs[0]?.entry.reason).toBe("context_tenant_mismatch");
  });

  it("repository indisponible : refus, jamais un accès (fail closed)", async () => {
    const broken: GrantRepository = {
      findMembership: async () => {
        throw new Error("base indisponible");
      },
      findRole: async () => null,
      findPresetRoleByName: async () => null,
      listTeamRoleAssignments: async () => [],
    };
    const { app, logs } = await buildApp({ mode: "enforce", grants: broken });
    expect((await deploy(app, "pA")).statusCode).toBe(403);
    expect(logs[0]?.level).toBe("error");
  });

  it("un refus journalise sujet, action, ressource et raison", async () => {
    const { app, logs } = await buildApp({ mode: "enforce" });
    await deploy(app, "pB");
    expect(logs[0]?.entry).toMatchObject({
      action: "project.deploy",
      userId: "u1",
      tenantId: T1,
      resource: { type: "project", id: "pB" },
      reason: "scope_not_covered",
    });
  });
});

describe("garde : shadow", () => {
  it("legacy autorise, moteur refuse : réponse du legacy, divergence engine_stricter", async () => {
    const { app, logs } = await buildApp({
      mode: "shadow",
      legacyAllowed: true,
    });
    expect((await deploy(app, "pB")).statusCode).toBe(200);
    expect(logs[0]).toMatchObject({
      level: "warn",
      entry: { divergence: "engine_stricter" },
    });
  });

  it("legacy refuse, moteur autorise : réponse du legacy, divergence bloquante (error)", async () => {
    const { app, logs } = await buildApp({
      mode: "shadow",
      legacyAllowed: false,
    });
    expect((await deploy(app, "pA")).statusCode).toBe(403);
    expect(logs[0]).toMatchObject({
      level: "error",
      entry: { divergence: "engine_more_permissive" },
    });
  });

  it("accord : aucune divergence journalisée", async () => {
    const { app, logs } = await buildApp({
      mode: "shadow",
      legacyAllowed: true,
    });
    expect((await deploy(app, "pA")).statusCode).toBe(200);
    expect(logs).toHaveLength(0);
  });
});

describe("résolution du mode", () => {
  it("valeurs valides, insensibles à la casse", () => {
    expect(resolveMode(" Shadow ", "production")).toBe("shadow");
    expect(resolveMode("legacy", "production")).toBe("legacy");
  });
  it("inconnu ou absent hors test : enforce", () => {
    expect(resolveMode("nope", "production")).toBe("enforce");
    expect(resolveMode(undefined, "production")).toBe("enforce");
    expect(resolveMode("nope", "test")).toBe("enforce");
  });
  it("absent sous NODE_ENV=test : legacy", () => {
    expect(resolveMode(undefined, "test")).toBe("legacy");
  });
});
