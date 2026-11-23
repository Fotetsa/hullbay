import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createAuthorization } from "../authorization.service";
import {
  PrismaGrantRepository,
  PrismaResourceRepository,
} from "../repositories/prisma";
import {
  ensurePermissions,
  ensureTenantPresets,
  syncCatalog,
  ADMIN_KEYS,
} from "../presets.mjs";
import { AdminError } from "../admin/errors";
import {
  clearMembershipRole,
  setMembershipRole,
} from "../admin/assignment.service";
import {
  cloneRole,
  createRole,
  deleteRole,
  setRolePermissions,
  updateRole,
} from "../admin/role.service";
import {
  addTeamMember,
  assignTeamRole,
  createTeam,
} from "../admin/team.service";
import { effectivePermissions } from "../admin/effective.service";
import { testSubject } from "./test-subject";

const prisma = new PrismaClient();
const authz = createAuthorization({
  grants: new PrismaGrantRepository(prisma),
  resources: new PrismaResourceRepository(prisma),
});
const sfx = Date.now();
const tenants: string[] = [];

async function mkTenant(label: string) {
  const t = await prisma.tenant.create({
    data: { name: label, slug: `adm-${label}-${sfx}` },
  });
  tenants.push(t.id);
  await ensureTenantPresets(prisma, t.id, await ensurePermissions(prisma));
  return t.id;
}
async function mkMember(tenantId: string, name: string, legacy: string) {
  const u = await prisma.user.create({
    data: { email: `adm-${name}-${sfx}@test.local` },
  });
  const m = await prisma.membership.create({
    data: { userId: u.id, tenantId, role: legacy },
  });
  return {
    userId: u.id,
    membershipId: m.id,
    tenantId,
    subject: testSubject(u.id, tenantId),
  };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AdminError ? e.code : `other:${String(e)}`;
  }
};
const ADMIN_PERMS = [
  { permission: "role.update" },
  { permission: "membership.role.assign" },
  { permission: "role.read" },
];

afterAll(async () => {
  for (const id of tenants)
    await prisma.tenant.delete({ where: { id } }).catch(() => {});
  await prisma.user
    .deleteMany({ where: { email: { contains: String(sfx) } } })
    .catch(() => {});
  await prisma.$disconnect();
});

describe("scénario de la mission", () => {
  let T: string,
    admin: Awaited<ReturnType<typeof mkMember>>,
    alice: typeof admin,
    bob: typeof admin;
  let cluster: { id: string },
    pA: { id: string },
    pB: { id: string },
    pC: { id: string };

  beforeAll(async () => {
    T = await mkTenant("mission");
    admin = await mkMember(T, "admin", "owner");
    alice = await mkMember(T, "alice", "viewer");
    bob = await mkMember(T, "bob", "viewer");
    cluster = await prisma.cluster.create({
      data: { tenantId: T, name: "prod", dockerHost: "", caddyAdminUrl: "" },
    });
    const mk = (n: string) =>
      prisma.project.create({
        data: {
          tenantId: T,
          clusterId: cluster.id,
          name: n,
          slug: `${n}-${sfx}`,
        },
      });
    [pA, pB, pC] = [await mk("a"), await mk("b"), await mk("c")];
  }, 120000);

  it("équipe Backend + rôle Project Developer limité aux projets A et B", async () => {
    const team = await createTeam(prisma, admin.subject, { name: "Backend" });
    const grants = ["project.read", "project.update", "project.deploy"].flatMap(
      (permission) =>
        [pA, pB].map((p) => ({
          permission,
          scopeType: "project",
          scopeId: p.id,
        })),
    );
    const role = await createRole(prisma, admin.subject, {
      name: "Project Developer",
      permissions: grants,
    });
    await assignTeamRole(prisma, admin.subject, team.id, { roleId: role.id });
    await addTeamMember(prisma, admin.subject, team.id, alice.membershipId);

    const deploy = (id: string) =>
      authz.can({
        subject: alice.subject,
        action: "project.deploy",
        resource: { type: "project", id },
      });
    const a = await deploy(pA.id);
    expect(a.allowed).toBe(true);
    expect(a.sources[0]).toMatchObject({ via: "team" });
    expect((await deploy(pB.id)).allowed).toBe(true);
    expect((await deploy(pC.id)).allowed).toBe(false);
    expect(
      (
        await authz.can({
          subject: alice.subject,
          action: "cluster.update",
          resource: { type: "cluster", id: cluster.id },
        })
      ).allowed,
    ).toBe(false);
    expect(
      (
        await authz.can({
          subject: bob.subject,
          action: "project.deploy",
          resource: { type: "project", id: pA.id },
        })
      ).allowed,
    ).toBe(false);

    const eff = await effectivePermissions(prisma, T, alice.userId);
    const dep = eff.permissions.find((p) => p.key === "project.deploy")!;
    expect(dep.grants).toHaveLength(2);
  });

  it("« Security Auditor » se crée sans modifier le code", async () => {
    const role = await createRole(prisma, admin.subject, {
      name: "Security Auditor",
      permissions: [
        { permission: "audit.read" },
        { permission: "provider.read" },
      ],
    });
    await setMembershipRole(prisma, admin.subject, bob.membershipId, role.id);
    expect(
      (await authz.can({ subject: bob.subject, action: "audit.read" })).allowed,
    ).toBe(true);
    expect(
      (
        await authz.can({
          subject: bob.subject,
          action: "project.deploy",
          resource: { type: "project", id: pA.id },
        })
      ).allowed,
    ).toBe(false);
  });

  it("clonage fidèle, non preset, non système", async () => {
    const owner = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: T, name: "Operator" } },
    });
    const clone = await cloneRole(
      prisma,
      admin.subject,
      owner.id,
      "Operator bis",
    );
    expect(clone.permissions).toHaveLength(25);
    expect(clone).toMatchObject({ isPreset: false, isSystem: false });
  });
});

describe("règles de sécurité", () => {
  it("anti-escalade : on n'accorde que ce que l'on possède", async () => {
    const T = await mkTenant("esc");
    const admin = await mkMember(T, "esc-admin", "owner");
    const carol = await mkMember(T, "carol", "viewer");
    const lim = await createRole(prisma, admin.subject, {
      name: "RoleAdmin",
      permissions: [
        { permission: "role.read" },
        { permission: "role.create" },
        { permission: "role.update" },
      ],
    });
    await setMembershipRole(prisma, admin.subject, carol.membershipId, lim.id);
    expect(
      await code(
        createRole(prisma, carol.subject, {
          name: "x",
          permissions: [{ permission: "cluster.delete" }],
        }),
      ),
    ).toBe("cannot_grant_unowned");
    expect(
      await code(
        createRole(prisma, carol.subject, {
          name: "y",
          permissions: [{ permission: "role.read" }],
        }),
      ),
    ).toBe("ok");
    // se donner un droit non possédé sur son propre rôle : refusé
    expect(
      await code(
        setRolePermissions(prisma, carol.subject, lim.id, [
          { permission: "role.update" },
          { permission: "user.delete" },
        ]),
      ),
    ).toBe("cannot_grant_unowned");
  });

  it("Root est intouchable", async () => {
    const T = await mkTenant("root");
    const admin = await mkMember(T, "root-admin", "owner");
    const m2 = await mkMember(T, "root-m2", "viewer");
    const root = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: T, name: "Root" } },
    });
    expect(
      await code(updateRole(prisma, admin.subject, root.id, { name: "x" })),
    ).toBe("system_role");
    expect(await code(deleteRole(prisma, admin.subject, root.id))).toBe(
      "system_role",
    );
    expect(
      await code(
        setRolePermissions(prisma, admin.subject, root.id, [
          { permission: "role.read" },
        ]),
      ),
    ).toBe("system_role");
    expect(await code(cloneRole(prisma, admin.subject, root.id, "copie"))).toBe(
      "system_role",
    );
    expect(
      await code(
        setMembershipRole(prisma, admin.subject, m2.membershipId, root.id),
      ),
    ).toBe("system_role");
  });

  it("rôle attribué : suppression refusée ; preset utilisé par le legacy : renommage refusé", async () => {
    const T = await mkTenant("use");
    const admin = await mkMember(T, "use-admin", "owner");
    const u = await mkMember(T, "use-u", "viewer");
    const r = await createRole(prisma, admin.subject, {
      name: "Temp",
      permissions: [{ permission: "role.read" }],
    });
    await setMembershipRole(prisma, admin.subject, u.membershipId, r.id);
    expect(await code(deleteRole(prisma, admin.subject, r.id))).toBe(
      "role_in_use",
    );
    const viewer = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: T, name: "Viewer" } },
    });
    expect(
      await code(
        updateRole(prisma, admin.subject, viewer.id, { name: "Lecteur" }),
      ),
    ).toBe("preset_in_legacy_use");
    expect(await code(deleteRole(prisma, admin.subject, viewer.id))).toBe(
      "preset_in_legacy_use",
    );
  });

  it("cross-tenant : un rôle ou une adhésion d'un autre tenant donne 404", async () => {
    const T1 = await mkTenant("x1"),
      T2 = await mkTenant("x2");
    const a1 = await mkMember(T1, "x-a1", "owner");
    const a2 = await mkMember(T2, "x-a2", "owner");
    const r2 = await createRole(prisma, a2.subject, {
      name: "R2",
      permissions: [{ permission: "role.read" }],
    });
    expect(
      await code(setMembershipRole(prisma, a1.subject, a1.membershipId, r2.id)),
    ).toBe("not_found");
    expect(
      await code(setMembershipRole(prisma, a1.subject, a2.membershipId, r2.id)),
    ).toBe("not_found");
    expect(
      await code(
        createRole(prisma, a1.subject, {
          name: "z",
          permissions: [
            {
              permission: "project.read",
              scopeType: "cluster",
              scopeId: "inexistant",
            },
          ],
        }),
      ),
    ).toBe("invalid_scope");
  });

  it("anti-verrouillage : le dernier administrateur ne peut pas se retirer ses droits", async () => {
    const T = await mkTenant("lock");
    const admin = await mkMember(T, "lock-admin", "owner");
    const weak = await createRole(prisma, admin.subject, {
      name: "Weak",
      permissions: [{ permission: "role.read" }],
    });
    expect(
      await code(
        setMembershipRole(prisma, admin.subject, admin.membershipId, weak.id),
      ),
    ).toBe("would_lock_out_tenant");
    const m = await prisma.membership.findUniqueOrThrow({
      where: { id: admin.membershipId },
    });
    expect(m.roleId).toBeNull(); // la transaction a été annulée
  });

  it("concurrence : deux administrateurs se retirent leurs droits simultanément, un seul réussit", async () => {
    const T = await mkTenant("race");
    const a1 = await mkMember(T, "race-1", "owner");
    const a2 = await mkMember(T, "race-2", "owner");
    const weak = await createRole(prisma, a1.subject, {
      name: "Weak",
      permissions: [{ permission: "role.read" }],
    });
    const res = await Promise.allSettled([
      setMembershipRole(prisma, a1.subject, a1.membershipId, weak.id),
      setMembershipRole(prisma, a2.subject, a2.membershipId, weak.id),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = res.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    expect((rejected.reason as AdminError).code).toBe("would_lock_out_tenant");
  });

  it("retirer le rôle direct ramène au rôle historique", async () => {
    const T = await mkTenant("clear");
    const admin = await mkMember(T, "clear-admin", "owner");
    const u = await mkMember(T, "clear-u", "viewer");
    const r = await createRole(prisma, admin.subject, {
      name: "Aud",
      permissions: [{ permission: "audit.read" }],
    });
    await setMembershipRole(prisma, admin.subject, u.membershipId, r.id);
    expect(
      (await authz.can({ subject: u.subject, action: "audit.read" })).allowed,
    ).toBe(true);
    await clearMembershipRole(prisma, admin.subject, u.membershipId);
    expect(
      (await authz.can({ subject: u.subject, action: "audit.read" })).allowed,
    ).toBe(false);
    expect(
      (await authz.can({ subject: u.subject, action: "project.read" })).allowed,
    ).toBe(true);
  });
});

describe("presets et distribution", () => {
  it("un tenant créé en base reçoit 4 rôles (72 / 25 / 4 / 0), de façon idempotente", async () => {
    const t = await prisma.tenant.create({
      data: { name: "bare", slug: `adm-bare-${sfx}` },
    });
    tenants.push(t.id);
    const byKey = await ensurePermissions(prisma);
    await ensureTenantPresets(prisma, t.id, byKey);
    await ensureTenantPresets(prisma, t.id, byKey);
    const roles = await prisma.role.findMany({
      where: { tenantId: t.id },
      include: { _count: { select: { rolePermissions: true } } },
    });
    expect(
      Object.fromEntries(roles.map((r) => [r.name, r._count.rolePermissions])),
    ).toEqual({
      Owner: 72,
      Operator: 25,
      Viewer: 4,
      Root: 0,
    });
  });

  it("sync-catalog complète un Owner non modifié et ignore un Owner personnalisé", async () => {
    const t1 = await mkTenant("sync1"),
      t2 = await mkTenant("sync2");
    const ownerOf = (t: string) =>
      prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: t, name: "Owner" } },
      });
    const strip = async (t: string, extra: string[] = []) => {
      const o = await ownerOf(t);
      await prisma.rolePermission.deleteMany({
        where: {
          roleId: o.id,
          permission: { key: { in: [...ADMIN_KEYS, ...extra] } },
        },
      });
      return o;
    };
    const o1 = await strip(t1);
    const o2 = await strip(t2, ["registry.read"]);
    const report = await syncCatalog(prisma);
    expect(report.updated).toContain(t1);
    expect(report.skipped.map((s) => s.tenantId)).toContain(t2);
    expect(
      await prisma.rolePermission.count({ where: { roleId: o1.id } }),
    ).toBe(72);
    expect(
      await prisma.rolePermission.count({ where: { roleId: o2.id } }),
    ).toBe(59);
    const again = await syncCatalog(prisma);
    expect(again.updated).not.toContain(t1);
  });
});
