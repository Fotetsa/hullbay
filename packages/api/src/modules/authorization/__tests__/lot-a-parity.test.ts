import { describe, it, expect, vi, beforeAll } from "vitest";
import Fastify from "fastify";
import { createAuthorization } from "../authorization.service";
import {
  MemoryGrantRepository,
  MemoryResourceRepository,
} from "../repositories/memory";
import type { ResourceRecord } from "../engine/types";
import { VIEWER_KEYS, OPERATOR_KEYS, OWNER_KEYS } from "./preset-matrix";
import type { FastifyRequest } from "fastify";

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

// Les utilisateurs de ces tests n'existent pas en base : on neutralise la lecture
// de la membership et on rend le rôle du token, pour comparer le legacy au moteur
// sur les mêmes entrées.
vi.mock("../../auth/identity/auth-identity.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/identity/auth-identity.service")>()
  return {
    ...actual,
    resolveRoleForUser: async (_userId: string, _tenantId: string, fallback: string) => fallback,
  }
})

import { registerObservabilityRoutes } from "../../observability/routes";
import { registerProjectRoutes } from "../../projects/routes";
import { registerSecretsRoutes } from "../../secrets/routes";

const T1 = "t1";
const T2 = "t2";

const RESOURCES: ResourceRecord[] = [
  { type: "cluster", id: "c1", tenantId: T1, parents: {} },
  { type: "cluster", id: "c2", tenantId: T1, parents: {} },
  { type: "project", id: "p1", tenantId: T1, parents: { cluster: "c1" } },
  { type: "project", id: "p2", tenantId: T1, parents: { cluster: "c2" } },
  { type: "project", id: "pX", tenantId: T2, parents: {} },
  {
    type: "node",
    id: "n1",
    tenantId: T1,
    parents: { project: "p1", cluster: "c1" },
  },
  {
    type: "edge",
    id: "e1",
    tenantId: T1,
    parents: { project: "p1", cluster: "c1" },
  },
];

const preset = (id: string, name: string, keys: string[]) => ({
  id,
  tenantId: T1,
  name,
  isSystem: false,
  isPreset: true,
  permissions: keys.map((key) => ({ key, scopeType: "tenant", scopeId: T1 })),
});

const devRole = {
  id: "r-dev",
  tenantId: T1,
  name: "Dev",
  isSystem: false,
  permissions: [
    { key: "graph.node.create", scopeType: "project", scopeId: "p1" },
    { key: "secret.set", scopeType: "cluster", scopeId: "c1" },
  ],
};

const ROLES = ["viewer", "operator", "owner"] as const;
const PARAMS: Record<string, string> = {
  id: "p1",
  nodeId: "n1",
  edgeId: "e1",
  clusterId: "c1",
  name: "s1",
};

type Captured = { method: string; url: string; guarded: boolean };
const captured: Captured[] = [];
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
          id: "m-dev",
          userId: "u-dev",
          tenantId: T1,
          legacyRole: "",
          roleId: "r-dev",
        },
      ],
      roles: [
        preset("rv", "Viewer", VIEWER_KEYS),
        preset("ro", "Operator", OPERATOR_KEYS),
        preset("rw", "Owner", OWNER_KEYS),
        devRole,
      ],
      teamMembers: [],
      teamRoles: [],
    }),
    resources: new MemoryResourceRepository(RESOURCES),
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
  await registerObservabilityRoutes(app);
  await registerProjectRoutes(app);
  await registerSecretsRoutes(app);
  await app.ready();
}, 120000);

const fill = (url: string) =>
  url.replace(/:([A-Za-z]+)/g, (_m, n: string) => PARAMS[n] ?? "x");

async function call(
  mode: typeof holder.mode,
  route: { method: string; url: string },
  user: string,
  role: string,
) {
  holder.mode = mode;
  const res = await app.inject({
    method: route.method as any,
    url: fill(route.url),
    headers: { "x-user": user, "x-role": role },
    payload: ["POST", "PATCH", "PUT"].includes(route.method) ? {} : undefined,
  });
  return res.statusCode;
}

describe("Lot A : inventaire des routes", () => {
  it("19 routes gardées ; toutes les routes sont désormais protégées", () => {
    const guarded = captured.filter((r) => r.guarded);
    expect(guarded).toHaveLength(19);
    expect(captured.filter((r) => !r.guarded)).toEqual([]);
  });
});

describe("Lot A : parité legacy / shadow / enforce pour owner, operator et viewer", () => {
  it("mêmes codes HTTP dans les trois modes, aucune divergence en shadow", async () => {
    const mismatches: string[] = [];
    for (const route of captured.filter((r) => r.guarded)) {
      for (const role of ROLES) {
        holder.logs.length = 0;
        const legacy = await call("legacy", route, `u-${role}`, role);
        const shadow = await call("shadow", route, `u-${role}`, role);
        const shadowLogs = holder.logs.length;
        const enforce = await call("enforce", route, `u-${role}`, role);
        if (legacy !== enforce || legacy !== shadow || shadowLogs > 0) {
          mismatches.push(
            `${route.method} ${route.url} [${role}] legacy=${legacy} shadow=${shadow} enforce=${enforce} divergences=${shadowLogs}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("la matrice attendue : viewer lit tout en GET sauf les secrets, operator écrit, owner a tout", async () => {
    const guarded = captured.filter((r) => r.guarded);
    for (const route of guarded) {
      const isRead = route.method === "GET" && !route.url.includes("/secrets");
      expect(await call("enforce", route, "u-viewer", "viewer")).toBe(
        isRead ? 200 : 403,
      );
      expect(await call("enforce", route, "u-operator", "operator")).toBe(200);
      expect(await call("enforce", route, "u-owner", "owner")).toBe(200);
    }
  });
});

describe("Lot A : scope et tenant sur de vraies routes (enforce)", () => {
  const as = (method: string, url: string, user = "u-dev") => {
    holder.mode = "enforce";
    return app.inject({
      method: method as any,
      url,
      headers: { "x-user": user, "x-role": "viewer" },
      payload: method === "POST" ? {} : undefined,
    });
  };

  it("rôle limité au projet p1 : crée un nœud dans p1, pas dans p2 (même tenant)", async () => {
    expect((await as("POST", "/api/projects/p1/nodes")).statusCode).toBe(200);
    expect((await as("POST", "/api/projects/p2/nodes")).statusCode).toBe(403);
  });

  it("rôle limité au cluster c1 : écrit un secret sur c1, pas sur c2", async () => {
    expect((await as("POST", "/api/clusters/c1/secrets")).statusCode).toBe(200);
    expect((await as("POST", "/api/clusters/c2/secrets")).statusCode).toBe(403);
  });

  it("ce rôle ne peut pas supprimer un projet ni lire un secret (permissions distinctes)", async () => {
    expect((await as("DELETE", "/api/projects/p1")).statusCode).toBe(403);
    expect((await as("GET", "/api/clusters/c1/secrets")).statusCode).toBe(403);
  });

  it("projet d'un autre tenant et projet inexistant : le même 404, sans reason", async () => {
    const other = await as("POST", "/api/projects/pX/nodes", "u-owner");
    const missing = await as("POST", "/api/projects/zzz/nodes", "u-owner");
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(other.json()).toEqual(missing.json());
    expect(JSON.stringify(other.json())).not.toMatch(/tenant|reason|scope/i);
  });
});
