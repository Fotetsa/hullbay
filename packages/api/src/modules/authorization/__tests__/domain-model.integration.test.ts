import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { isValidScopeType, tenantScope } from "../scope";

const prisma = new PrismaClient();
const suffix = Date.now();

let tenantA: { id: string };
let tenantB: { id: string };
let roleA: { id: string };
let roleA2: { id: string };
let roleB: { id: string };
let teamA: { id: string };
let teamB: { id: string };
let membershipA: { id: string };
let membershipB: { id: string };
let policyA: { id: string };
let clusterA: { id: string };
let clusterB: { id: string };
let providerA: { id: string };
let providerB: { id: string };
let providerGlobal: { id: string };

const runSeed = () =>
  execSync("node src/modules/authorization/scripts/seed-authorization.mjs", {
    cwd: process.cwd(),
    stdio: "pipe",
  });

beforeAll(async () => {
  tenantA = await prisma.tenant.create({
    data: { name: "A", slug: `tenant-a-${suffix}` },
  });
  tenantB = await prisma.tenant.create({
    data: { name: "B", slug: `tenant-b-${suffix}` },
  });
  const userA = await prisma.user.create({
    data: { email: `iso-a-${suffix}@test.local` },
  });
  const userB = await prisma.user.create({
    data: { email: `iso-b-${suffix}@test.local` },
  });

  roleA = await prisma.role.create({
    data: { tenantId: tenantA.id, name: "Role A" },
  });
  roleA2 = await prisma.role.create({
    data: { tenantId: tenantA.id, name: "Role A2" },
  });
  roleB = await prisma.role.create({
    data: { tenantId: tenantB.id, name: "Role B" },
  });
  teamA = await prisma.team.create({
    data: { tenantId: tenantA.id, name: "Team A" },
  });
  teamB = await prisma.team.create({
    data: { tenantId: tenantB.id, name: "Team B" },
  });
  membershipA = await prisma.membership.create({
    data: { userId: userA.id, tenantId: tenantA.id, role: "operator" },
  });
  membershipB = await prisma.membership.create({
    data: { userId: userB.id, tenantId: tenantB.id, role: "viewer" },
  });
  policyA = await prisma.policy.create({
    data: {
      tenantId: tenantA.id,
      name: "Policy A",
      effect: "allow",
      conditions: {},
    },
  });
  clusterA = await prisma.cluster.create({
    data: {
      tenantId: tenantA.id,
      name: "ca",
      dockerHost: "",
      caddyAdminUrl: "",
    },
  });
  clusterB = await prisma.cluster.create({
    data: {
      tenantId: tenantB.id,
      name: "cb",
      dockerHost: "",
      caddyAdminUrl: "",
    },
  });
  providerA = await prisma.authProvider.create({
    data: { kind: "oidc", name: `pa-${suffix}`, tenantId: tenantA.id },
  });
  providerB = await prisma.authProvider.create({
    data: { kind: "oidc", name: `pb-${suffix}`, tenantId: tenantB.id },
  });
  providerGlobal = await prisma.authProvider.create({
    data: { kind: "oidc", name: `pg-${suffix}`, tenantId: null },
  });

  runSeed();
}, 120000);

afterAll(async () => {
  await prisma.authProvider
    .deleteMany({
      where: { id: { in: [providerA.id, providerB.id, providerGlobal.id] } },
    })
    .catch(() => {});
  await prisma.tenant.delete({ where: { id: tenantA.id } });
  await prisma.tenant.delete({ where: { id: tenantB.id } });
  await prisma.user.deleteMany({
    where: { email: { contains: String(suffix) } },
  });
  await prisma.$disconnect();
});

describe("34.1 isolation entre tenants", () => {
  it("Membership A vers Role B", async () => {
    await expect(
      prisma.membership.update({
        where: { id: membershipA.id },
        data: { roleId: roleB.id },
      }),
    ).rejects.toThrow();
  });
  it("TeamMember : équipe A avec adhésion B", async () => {
    await expect(
      prisma.teamMember.create({
        data: {
          tenantId: tenantA.id,
          teamId: teamA.id,
          membershipId: membershipB.id,
        },
      }),
    ).rejects.toThrow();
  });
  it("TeamRole : équipe A avec rôle B", async () => {
    await expect(
      prisma.teamRole.create({
        data: {
          tenantId: tenantA.id,
          teamId: teamA.id,
          roleId: roleB.id,
          ...tenantScope(tenantA.id),
        },
      }),
    ).rejects.toThrow();
  });
  it("PolicyBinding : policy A avec rôle B", async () => {
    await expect(
      prisma.policyBinding.create({
        data: { tenantId: tenantA.id, policyId: policyA.id, roleId: roleB.id },
      }),
    ).rejects.toThrow();
  });
  it("PolicyBinding : policy A avec équipe B", async () => {
    await expect(
      prisma.policyBinding.create({
        data: { tenantId: tenantA.id, policyId: policyA.id, teamId: teamB.id },
      }),
    ).rejects.toThrow();
  });
  it("ExternalGroupMapping : tenant A avec équipe B", async () => {
    await expect(
      prisma.externalGroupMapping.create({
        data: {
          tenantId: tenantA.id,
          providerId: providerA.id,
          externalGroupName: "g",
          teamId: teamB.id,
        },
      }),
    ).rejects.toThrow();
  });
  it("ExternalGroupMapping : tenant A avec provider du tenant B", async () => {
    await expect(
      prisma.externalGroupMapping.create({
        data: {
          tenantId: tenantA.id,
          providerId: providerB.id,
          externalGroupName: "g",
          teamId: teamA.id,
        },
      }),
    ).rejects.toThrow();
  });
  it("ExternalGroupMapping : provider global accepté", async () => {
    await expect(
      prisma.externalGroupMapping.create({
        data: {
          tenantId: tenantA.id,
          providerId: providerGlobal.id,
          externalGroupName: "glob",
          teamId: teamA.id,
        },
      }),
    ).resolves.toBeDefined();
  });
  it("l'association correcte est acceptée", async () => {
    await expect(
      prisma.teamMember.create({
        data: {
          tenantId: tenantA.id,
          teamId: teamA.id,
          membershipId: membershipA.id,
        },
      }),
    ).resolves.toBeDefined();
  });
});

describe("contraintes d'intégrité", () => {
  it("PolicyBinding sans rôle ni équipe refusé", async () => {
    await expect(
      prisma.policyBinding.create({
        data: { tenantId: tenantA.id, policyId: policyA.id },
      }),
    ).rejects.toThrow();
  });
  it("PolicyBinding avec scopeType sans scopeId refusé", async () => {
    await expect(
      prisma.policyBinding.create({
        data: {
          tenantId: tenantA.id,
          policyId: policyA.id,
          roleId: roleA.id,
          scopeType: "project",
        },
      }),
    ).rejects.toThrow();
  });
  it("Policy.effect limité à allow ou deny", async () => {
    await expect(
      prisma.policy.create({
        data: {
          tenantId: tenantA.id,
          name: "Mauvaise",
          effect: "peut-etre",
          conditions: {},
        },
      }),
    ).rejects.toThrow();
  });
  it("supprimer un rôle attribué met seulement roleId à NULL", async () => {
    const role = await prisma.role.create({
      data: { tenantId: tenantA.id, name: "Temporaire" },
    });
    await prisma.membership.update({
      where: { id: membershipA.id },
      data: { roleId: role.id },
    });
    await prisma.role.delete({ where: { id: role.id } });
    const after = await prisma.membership.findUniqueOrThrow({
      where: { id: membershipA.id },
    });
    expect(after.roleId).toBeNull();
    expect(after.tenantId).toBe(tenantA.id);
  });
});

describe("34.2 unicité", () => {
  it("nom de rôle unique par tenant, mais réutilisable dans un autre tenant", async () => {
    await expect(
      prisma.role.create({ data: { tenantId: tenantA.id, name: "Role A" } }),
    ).rejects.toThrow();
    await prisma.role.create({
      data: { tenantId: tenantA.id, name: "Commun" },
    });
    await expect(
      prisma.role.create({ data: { tenantId: tenantB.id, name: "Commun" } }),
    ).resolves.toBeDefined();
  });
  it("nom d'équipe unique par tenant", async () => {
    await expect(
      prisma.team.create({ data: { tenantId: tenantA.id, name: "Team A" } }),
    ).rejects.toThrow();
  });
  it("clé de permission unique globalement", async () => {
    await expect(
      prisma.permission.create({
        data: { key: "project.read", resource: "project", action: "read" },
      }),
    ).rejects.toThrow();
  });
  it("RolePermission unique par scope, et même scope permis sur plusieurs rôles", async () => {
    const p = await prisma.permission.findUniqueOrThrow({
      where: { key: "project.read" },
    });
    const data = { permissionId: p.id, ...tenantScope(tenantA.id) };
    await prisma.rolePermission.create({ data: { roleId: roleA.id, ...data } });
    await expect(
      prisma.rolePermission.create({ data: { roleId: roleA.id, ...data } }),
    ).rejects.toThrow();
    await expect(
      prisma.rolePermission.create({ data: { roleId: roleA2.id, ...data } }),
    ).resolves.toBeDefined();
  });
  it("TeamRole unique par scope", async () => {
    const data = {
      tenantId: tenantA.id,
      teamId: teamA.id,
      roleId: roleA.id,
      ...tenantScope(tenantA.id),
    };
    await prisma.teamRole.create({ data });
    await expect(prisma.teamRole.create({ data })).rejects.toThrow();
  });
  it("nom de policy unique par tenant", async () => {
    await expect(
      prisma.policy.create({
        data: {
          tenantId: tenantA.id,
          name: "Policy A",
          effect: "deny",
          conditions: {},
        },
      }),
    ).rejects.toThrow();
  });
  it("ExternalGroupMapping unique par tenant, provider et groupe", async () => {
    const data = {
      tenantId: tenantA.id,
      providerId: providerA.id,
      externalGroupName: "dup",
      teamId: teamA.id,
    };
    await prisma.externalGroupMapping.create({ data });
    await expect(
      prisma.externalGroupMapping.create({ data }),
    ).rejects.toThrow();
  });
});

describe("34.3 scopes", () => {
  it("valide les six types connus, refuse un type inconnu", () => {
    for (const t of [
      "tenant",
      "cluster",
      "server",
      "project",
      "node",
      "edge",
    ]) {
      expect(isValidScopeType(t)).toBe(true);
    }
    expect(isValidScopeType("unknown")).toBe(false);
  });
  it("le scope global s'écrit tenant:<id>", () => {
    expect(tenantScope("t1")).toEqual({ scopeType: "tenant", scopeId: "t1" });
  });
  it("scope tenant d'un autre tenant refusé pour un rôle du tenant courant", async () => {
    const p = await prisma.permission.findUniqueOrThrow({
      where: { key: "project.deploy" },
    });
    await expect(
      prisma.rolePermission.create({
        data: {
          roleId: roleA.id,
          permissionId: p.id,
          ...tenantScope(tenantB.id),
        },
      }),
    ).rejects.toThrow();
  });
  it("cluster d'un autre tenant refusé, cluster du même tenant accepté", async () => {
    const p = await prisma.permission.findUniqueOrThrow({
      where: { key: "cluster.update" },
    });
    await expect(
      prisma.rolePermission.create({
        data: {
          roleId: roleA.id,
          permissionId: p.id,
          scopeType: "cluster",
          scopeId: clusterB.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.rolePermission.create({
        data: {
          roleId: roleA.id,
          permissionId: p.id,
          scopeType: "cluster",
          scopeId: clusterA.id,
        },
      }),
    ).resolves.toBeDefined();
  });
  it("TeamRole : cluster d'un autre tenant refusé", async () => {
    await expect(
      prisma.teamRole.create({
        data: {
          tenantId: tenantA.id,
          teamId: teamA.id,
          roleId: roleA2.id,
          scopeType: "cluster",
          scopeId: clusterB.id,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("34.4 rôle Root", () => {
  const root = () =>
    prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantA.id, name: "Root" } },
    });

  it("existe en un seul exemplaire, système, attribué à personne", async () => {
    const r = await root();
    expect(r.isSystem).toBe(true);
    expect(
      await prisma.role.count({
        where: { tenantId: tenantA.id, name: "Root" },
      }),
    ).toBe(1);
    expect(await prisma.membership.count({ where: { roleId: r.id } })).toBe(0);
  });
  it("ne peut pas être supprimé, renommé, ni perdre son marqueur", async () => {
    const r = await root();
    await expect(prisma.role.delete({ where: { id: r.id } })).rejects.toThrow();
    await expect(
      prisma.role.update({ where: { id: r.id }, data: { name: "X" } }),
    ).rejects.toThrow();
    await expect(
      prisma.role.update({ where: { id: r.id }, data: { isSystem: false } }),
    ).rejects.toThrow();
  });
  it("ne peut recevoir aucune permission", async () => {
    const r = await root();
    const p = await prisma.permission.findUniqueOrThrow({
      where: { key: "project.read" },
    });
    await expect(
      prisma.rolePermission.create({
        data: { roleId: r.id, permissionId: p.id, ...tenantScope(tenantA.id) },
      }),
    ).rejects.toThrow();
  });
  it("ne peut être attribué ni à une adhésion ni à une équipe", async () => {
    const r = await root();
    await expect(
      prisma.membership.update({
        where: { id: membershipA.id },
        data: { roleId: r.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.teamRole.create({
        data: {
          tenantId: tenantA.id,
          teamId: teamA.id,
          roleId: r.id,
          ...tenantScope(tenantA.id),
        },
      }),
    ).rejects.toThrow();
  });
});

describe("34.5 presets", () => {
  const keysOf = async (tenantId: string, name: string) => {
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId, name } },
      include: { rolePermissions: { include: { permission: true } } },
    });
    return role.rolePermissions.map((rp) => rp.permission.key).sort();
  };

  it("nombre exact de permissions : Viewer 2, Operator 19, Owner 50", async () => {
    expect((await keysOf(tenantA.id, "Viewer")).length).toBe(2);
    expect((await keysOf(tenantA.id, "Operator")).length).toBe(19);
    expect((await keysOf(tenantA.id, "Owner")).length).toBe(50);
  });
  it("Viewer exact, Operator sans permission d'infrastructure", async () => {
    expect(await keysOf(tenantA.id, "Viewer")).toEqual([
      "logs.read",
      "project.read",
    ]);
    const op = await keysOf(tenantA.id, "Operator");
    expect(op).toContain("project.deploy");
    expect(op).toContain("audit.read");
    expect(op).not.toContain("cluster.delete");
    expect(op).not.toContain("prune.apply");
  });
  it("presets : isPreset vrai, isSystem faux", async () => {
    for (const name of ["Owner", "Operator", "Viewer"]) {
      const r = await prisma.role.findUniqueOrThrow({
        where: { tenantId_name: { tenantId: tenantA.id, name } },
      });
      expect(r.isPreset).toBe(true);
      expect(r.isSystem).toBe(false);
    }
  });
});

describe("34.6 migration, peuplement, compatibilité", () => {
  const counts = async () => ({
    perms: await prisma.permission.count(),
    rolesA: await prisma.role.count({ where: { tenantId: tenantA.id } }),
    rolePermsA: await prisma.rolePermission.count({
      where: { role: { tenantId: tenantA.id } },
    }),
  });

  it("une seconde exécution ne crée aucun doublon (permissions, presets, Root)", async () => {
    const before = await counts();
    runSeed();
    expect(await counts()).toEqual(before);
    for (const name of ["Owner", "Operator", "Viewer", "Root"]) {
      expect(
        await prisma.role.count({ where: { tenantId: tenantA.id, name } }),
      ).toBe(1);
    }
  }, 60000);

  it("le peuplement ne réinitialise pas les permissions personnalisées d'un preset", async () => {
    const op = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantB.id, name: "Operator" } },
    });
    const audit = await prisma.permission.findUniqueOrThrow({
      where: { key: "audit.read" },
    });
    await prisma.rolePermission.deleteMany({
      where: { roleId: op.id, permissionId: audit.id },
    });
    runSeed();
    expect(
      await prisma.rolePermission.count({
        where: { roleId: op.id, permissionId: audit.id },
      }),
    ).toBe(0);
  }, 60000);

  it("Membership.role, tenants et adhésions existants sont préservés", async () => {
    const m = await prisma.membership.findUniqueOrThrow({
      where: { id: membershipA.id },
    });
    expect(m.role).toBe("operator");
    expect(
      await prisma.tenant.findUnique({ where: { id: tenantA.id } }),
    ).not.toBeNull();
    expect(
      await prisma.membership.findUnique({ where: { id: membershipB.id } }),
    ).not.toBeNull();
  });
});
