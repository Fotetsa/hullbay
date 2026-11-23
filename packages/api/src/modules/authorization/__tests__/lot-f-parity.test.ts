import { describe, it, expect, vi, beforeAll } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
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

import { registerAuthorizationAdminRoutes } from "../admin/routes";

const T1 = "t1";
const preset = (id: string, name: string, keys: string[]) => ({
  id,
  tenantId: T1,
  name,
  isSystem: false,
  isPreset: true,
  permissions: keys.map((key) => ({ key, scopeType: "tenant", scopeId: T1 })),
});
const reader = {
  id: "r-read",
  tenantId: T1,
  name: "Reader",
  isSystem: false,
  permissions: [{ key: "role.read", scopeType: "tenant", scopeId: T1 }],
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
          id: "m-read",
          userId: "u-read",
          tenantId: T1,
          legacyRole: "",
          roleId: "r-read",
        },
      ],
      roles: [
        preset("rv", "Viewer", VIEWER_KEYS),
        preset("ro", "Operator", OPERATOR_KEYS),
        preset("rw", "Owner", OWNER_KEYS),
        reader,
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
  await registerAuthorizationAdminRoutes(app);
  await app.ready();
}, 120000);

const fill = (u: string) => u.replace(/:([A-Za-z]+)/g, "x");
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
const guarded = () => captured.filter((r) => r.guarded);

describe("Lot F : routes d'administration", () => {
  it("20 routes gardées, seule « mes permissions » est ouverte", () => {
    expect(guarded()).toHaveLength(20);
    expect(captured.filter((r) => !r.guarded).map((r) => r.url)).toEqual([
      "/api/authorization/me/effective-permissions",
    ]);
  });

  it("mêmes codes en legacy, shadow et enforce, aucune divergence", async () => {
    const bad: string[] = [];
    for (const route of guarded()) {
      for (const role of ROLES) {
        holder.logs.length = 0;
        const l = await call("legacy", route, `u-${role}`, role);
        const s = await call("shadow", route, `u-${role}`, role);
        const logged = holder.logs.length;
        const e = await call("enforce", route, `u-${role}`, role);
        if (l !== s || l !== e || logged > 0)
          bad.push(
            `${route.method} ${route.url} [${role}] ${l}/${s}/${e} div=${logged}`,
          );
      }
    }
    expect(bad).toEqual([]);
  });

  it("owner passe partout, operator et viewer nulle part", async () => {
    for (const route of guarded()) {
      expect(await call("enforce", route, "u-owner", "owner")).toBe(200);
      expect(await call("enforce", route, "u-operator", "operator")).toBe(403);
      expect(await call("enforce", route, "u-viewer", "viewer")).toBe(403);
    }
  });

  it("un rôle avec la seule permission role.read lit rôles et catalogue, rien d'autre", async () => {
    const allowed = new Set([
      "GET /api/authorization/roles",
      "GET /api/authorization/roles/:id",
      "GET /api/authorization/permissions",
    ]);
    for (const route of guarded()) {
      expect(await call("enforce", route, "u-read", "viewer")).toBe(
        allowed.has(`${route.method} ${route.url}`) ? 200 : 403,
      );
    }
  });
});
