import { describe, it, expect, vi, beforeAll } from "vitest";
import Fastify, { FastifyRequest } from "fastify";
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

import { registerReconcilerRoutes } from "../../reconciler/routes";

const T1 = "t1";
const RESOURCES: ResourceRecord[] = [
  { type: "project", id: "p1", tenantId: T1, parents: { cluster: "c1" } },
  { type: "project", id: "p2", tenantId: T1, parents: { cluster: "c2" } },
  { type: "project", id: "pX", tenantId: "t2", parents: {} },
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
  permissions: [{ key: "project.deploy", scopeType: "project", scopeId: "p1" }],
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
  await registerReconcilerRoutes(app);
  await app.ready();
}, 120000);

const fill = (url: string) =>
  url.replace(/:([A-Za-z]+)/g, (_m, n: string) => (n === "id" ? "p1" : "x"));

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
    payload: r.method === "POST" ? {} : undefined,
  });
  return res.statusCode;
}

describe("Lot B : reconciler", () => {
  it("7 routes gardées ; toutes les routes sont désormais protégées", () => {
    expect(captured.filter((r) => r.guarded)).toHaveLength(7);
    expect(captured.filter((r) => !r.guarded)).toEqual([]);
  });

  it("mêmes codes en legacy, shadow et enforce, aucune divergence", async () => {
    const mismatches: string[] = [];
    for (const route of captured.filter((r) => r.guarded)) {
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

  it("matrice : viewer lit en GET (sauf prune), operator tout sauf POST /api/prune, owner tout", async () => {
    for (const route of captured.filter((r) => r.guarded)) {
      const ownerOnly = route.method === "POST" && route.url === "/api/prune";
      const isRead = route.method === "GET" && route.url !== "/api/prune";

      expect(await call("enforce", route, "u-viewer", "viewer")).toBe(
        isRead ? 200 : 403,
      );
      expect(await call("enforce", route, "u-operator", "operator")).toBe(
        ownerOnly ? 403 : 200,
      );
      expect(await call("enforce", route, "u-owner", "owner")).toBe(200);
    }
  });

  it("rôle limité à p1 : déploie p1, pas p2, ne détruit pas, ne prune pas", async () => {
    holder.mode = "enforce";
    const as = (m: string, u: string) =>
      app.inject({
        method: m as any,
        url: u,
        headers: { "x-user": "u-dev", "x-role": "viewer" },
        payload: m === "POST" ? {} : undefined,
      });
    expect((await as("POST", "/api/projects/p1/deploy")).statusCode).toBe(200);
    expect((await as("POST", "/api/projects/p2/deploy")).statusCode).toBe(403);
    expect((await as("POST", "/api/projects/p1/destroy")).statusCode).toBe(403);
    expect((await as("POST", "/api/rebuild-from-docker")).statusCode).toBe(403);
    expect((await as("GET", "/api/prune")).statusCode).toBe(403);
  });

  it("projet d'un autre tenant et inexistant : même 404", async () => {
    holder.mode = "enforce";
    const as = (id: string) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${id}/deploy`,
        headers: { "x-user": "u-owner", "x-role": "owner" },
        payload: {},
      });
    const a = await as("pX"),
      b = await as("zzz");
    expect(a.statusCode).toBe(404);
    expect(a.json()).toEqual(b.json());
  });
});
