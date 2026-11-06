import { describe, it, expect, vi, beforeAll } from "vitest";
import Fastify, { FastifyRequest} from "fastify";
import { createAuthorization } from "../authorization.service";
import {
  MemoryGrantRepository,
  MemoryResourceRepository,
} from "../repositories/memory";
import type { ResourceRecord } from "../engine/types";
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

import { registerClustersRoutes } from "../../clusters/routes";
import { registerServersRoutes } from "../../servers/routes";

const T1 = "t1";
const RESOURCES: ResourceRecord[] = [
  { type: "cluster", id: "c1", tenantId: T1, parents: {} },
  { type: "cluster", id: "c2", tenantId: T1, parents: {} },
  { type: "cluster", id: "cX", tenantId: "t2", parents: {} },
  { type: "server", id: "s1", tenantId: T1, parents: { cluster: "c1" } },
  { type: "server", id: "s2", tenantId: T1, parents: { cluster: "c2" } },
];
const preset = (id: string, name: string, keys: string[]) => ({
  id,
  tenantId: T1,
  name,
  isSystem: false,
  isPreset: true,
  permissions: keys.map((key) => ({ key, scopeType: "tenant", scopeId: T1 })),
});
const opsRole = {
  id: "r-ops",
  tenantId: T1,
  name: "Ops",
  isSystem: false,
  permissions: [
    { key: "server.promote", scopeType: "server", scopeId: "s1" },
    { key: "server.create", scopeType: "cluster", scopeId: "c1" },
    { key: "cluster.delete", scopeType: "cluster", scopeId: "c1" },
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
          id: "m-ops",
          userId: "u-ops",
          tenantId: T1,
          legacyRole: "",
          roleId: "r-ops",
        },
      ],
      roles: [
        preset("rv", "Viewer", VIEWER_KEYS),
        preset("ro", "Operator", OPERATOR_KEYS),
        preset("rw", "Owner", OWNER_KEYS),
        opsRole,
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
  await registerClustersRoutes(app);
  await registerServersRoutes(app);
  await app.ready();
}, 120000);

const fill = (url: string) =>
  url.replace(/:id/, url.startsWith("/api/servers") ? "s1" : "c1");
const BODY = (r: { method: string; url: string }) =>
  r.url.endsWith("/role") ? { role: "manager" } : {};

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
    payload: r.method === "POST" ? BODY(r) : undefined,
  });
  return res.statusCode;
}

const as = (user: string, method: string, url: string, payload?: unknown) => {
  holder.mode = "enforce";
  return app.inject({
    method: method as any,
    url,
    headers: { "x-user": user, "x-role": "viewer" },
    payload: payload as any,
  });
};

describe("Lot C : clusters et servers", () => {
  it("7 routes gardées, aucune ouverte", () => {
    expect(captured.filter((r) => r.guarded)).toHaveLength(7);
    expect(captured.filter((r) => !r.guarded)).toEqual([]);
  });

  it("mêmes codes en legacy, shadow et enforce, aucune divergence", async () => {
    const mismatches: string[] = [];
    for (const route of captured) {
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

  it("matrice : owner passe partout, operator et viewer jamais", async () => {
    for (const route of captured) {
      expect(await call("enforce", route, "u-viewer", "viewer")).toBe(403);
      expect(await call("enforce", route, "u-operator", "operator")).toBe(403);
      expect(await call("enforce", route, "u-owner", "owner")).toBe(200);
    }
  });

  it("changement de rôle : l'action suit la valeur demandée (promote ou demote)", async () => {
    // u-ops a server.promote sur s1 uniquement.
    expect(
      (await as("u-ops", "POST", "/api/servers/s1/role", { role: "manager" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await as("u-ops", "POST", "/api/servers/s1/role", { role: "worker" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await as("u-ops", "POST", "/api/servers/s2/role", { role: "manager" }))
        .statusCode,
    ).toBe(403);
  });

  it("création de serveur : server.create sur le cluster visé ; nouveau cluster exige cluster.create", async () => {
    expect(
      (await as("u-ops", "POST", "/api/servers", { clusterId: "c1" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await as("u-ops", "POST", "/api/servers", { clusterId: "c2" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await as("u-ops", "POST", "/api/servers", { newClusterName: "neuf" }))
        .statusCode,
    ).toBe(403);
    expect(
      (await as("u-owner", "POST", "/api/servers", { newClusterName: "neuf" }))
        .statusCode,
    ).toBe(200);
  });

  it("cluster : un rôle limité à c1 le supprime, pas c2 ; un autre tenant donne le même 404", async () => {
    expect((await as("u-ops", "DELETE", "/api/clusters/c1")).statusCode).toBe(
      200,
    );
    expect((await as("u-ops", "DELETE", "/api/clusters/c2")).statusCode).toBe(
      403,
    );
    const other = await as("u-owner", "DELETE", "/api/clusters/cX");
    const missing = await as("u-owner", "DELETE", "/api/clusters/zzz");
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual(missing.json());
  });

  it("les listes sont de niveau tenant : un rôle limité à un cluster ne les voit pas", async () => {
    expect((await as("u-ops", "GET", "/api/clusters")).statusCode).toBe(403);
    expect((await as("u-ops", "GET", "/api/servers")).statusCode).toBe(403);
  });
});
