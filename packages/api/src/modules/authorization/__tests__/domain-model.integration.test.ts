import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { isValidScopeType, tenantScope } from "../scope";

const prisma = new PrismaClient();
const suffix = Date.now();

let tenantA: { id: string };
let tenantB: { id: string };
let userId: string;
let roleA: { id: string };
let roleB: { id: string };
let teamA: { id: string };
let teamB: { id: string };
let membershipA: { id: string };
let membershipB: { id: string };
let policyA: { id: string };
let providerId: string;

function runSeed() {
  execSync("node src/modules/authorization/scripts/seed-authorization.mjs", {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}

beforeAll(async () => {
  tenantA = await prisma.tenant.create({
    data: { name: "A", slug: `tenant-a-${suffix}` },
  });
  tenantB = await prisma.tenant.create({
    data: { name: "B", slug: `tenant-b-${suffix}` },
  });
  const user = await prisma.user.create({
    data: { email: `iso-${suffix}@test.local` },
  });
  userId = user.id;
  const userB = await prisma.user.create({
    data: { email: `iso-b-${suffix}@test.local` },
  });

  roleA = await prisma.role.create({
    data: { tenantId: tenantA.id, name: "Role A" },
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
    data: { userId, tenantId: tenantA.id, role: "operator" },
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
  const provider = await prisma.authProvider.create({
    data: { kind: "oidc", name: `prov-${suffix}`, tenantId: tenantA.id },
  });
  providerId = provider.id;

  // Le seed s'applique à tous les tenants, y compris A et B.
  runSeed();
}, 120000);

afterAll(async () => {
  await prisma.authProvider
    .delete({ where: { id: providerId } })
    .catch(() => {});
  await prisma.tenant.delete({ where: { id: tenantA.id } }).catch((e) => {
    throw e;
  });
  await prisma.tenant.delete({ where: { id: tenantB.id } }).catch((e) => {
    throw e;
  });
  await prisma.user.deleteMany({
    where: { email: { contains: String(suffix) } },
  });
  await prisma.$disconnect();
});

describe("isolation entre tenants (rejet par la base elle-même)", () => {
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
          providerId,
          externalGroupName: "g",
          teamId: teamB.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("l'association correcte, elle, est acceptée", async () => {
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
  it("PolicyBinding sans rôle ni équipe est refusé", async () => {
    await expect(
      prisma.policyBinding.create({
        data: { tenantId: tenantA.id, policyId: policyA.id },
      }),
    ).rejects.toThrow();
  });

  it("une policy n'accepte que allow ou deny", async () => {
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

describe("unicité", () => {
  it("deux rôles de même nom dans un tenant sont refusés", async () => {
    await expect(
      prisma.role.create({ data: { tenantId: tenantA.id, name: "Role A" } }),
    ).rejects.toThrow();
  });

  it("le même nom est permis dans deux tenants différents", async () => {
    await prisma.role.create({
      data: { tenantId: tenantA.id, name: "Commun" },
    });
    await expect(
      prisma.role.create({ data: { tenantId: tenantB.id, name: "Commun" } }),
    ).resolves.toBeDefined();
  });

  it("deux équipes de même nom dans un tenant sont refusées", async () => {
    await expect(
      prisma.team.create({ data: { tenantId: tenantA.id, name: "Team A" } }),
    ).rejects.toThrow();
  });

  it("la clé d'une permission est unique", async () => {
    await expect(
      prisma.permission.create({
        data: { key: "project.read", resource: "project", action: "read" },
      }),
    ).rejects.toThrow();
  });
});

describe("scopes", () => {
  it("accepte les six types connus et refuse un type inconnu", () => {
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
    expect(isValidScopeType("inconnu")).toBe(false);
  });

  it("le scope global d'un tenant s'écrit tenant:<id>", () => {
    expect(tenantScope("t1")).toEqual({ scopeType: "tenant", scopeId: "t1" });
  });
});

describe("rôle Root", () => {
  async function root() {
    return prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantA.id, name: "Root" } },
    });
  }

  it("existe, est système, et n'est attribué à personne", async () => {
    const r = await root();
    expect(r.isSystem).toBe(true);
    expect(await prisma.membership.count({ where: { roleId: r.id } })).toBe(0);
  });

  it("ne peut pas être supprimé", async () => {
    const r = await root();
    await expect(prisma.role.delete({ where: { id: r.id } })).rejects.toThrow();
  });

  it("ne peut pas être renommé", async () => {
    const r = await root();
    await expect(
      prisma.role.update({ where: { id: r.id }, data: { name: "Autre" } }),
    ).rejects.toThrow();
  });

  it("ne peut pas perdre son marqueur système", async () => {
    const r = await root();
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
});

describe("presets et peuplement", () => {
  async function keysOf(name: string) {
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tenantA.id, name } },
      include: { rolePermissions: { include: { permission: true } } },
    });
    return role.rolePermissions.map((rp) => rp.permission.key).sort();
  }

  it("Viewer, Operator et Owner ont le bon nombre de permissions", async () => {
    expect((await keysOf("Viewer")).length).toBe(2);
    expect((await keysOf("Operator")).length).toBe(19);
    expect((await keysOf("Owner")).length).toBe(50);
  });

  it("Viewer contient exactement project.read et logs.read", async () => {
    expect(await keysOf("Viewer")).toEqual(["logs.read", "project.read"]);
  });

  it("Operator contient tout Viewer, mais aucune permission d'infrastructure", async () => {
    const op = await keysOf("Operator");
    expect(op).toContain("project.deploy");
    expect(op).toContain("audit.read");
    expect(op).not.toContain("cluster.delete");
    expect(op).not.toContain("prune.apply");
  });

  it("le catalogue complet compte 50 permissions", async () => {
    expect(await prisma.permission.count()).toBeGreaterThanOrEqual(50);
  });

  it("une seconde exécution du peuplement ne crée aucun doublon", async () => {
    const before = {
      perms: await prisma.permission.count(),
      roles: await prisma.role.count({ where: { tenantId: tenantA.id } }),
      rolePerms: await prisma.rolePermission.count({
        where: { role: { tenantId: tenantA.id } },
      }),
    };
    runSeed();
    const after = {
      perms: await prisma.permission.count(),
      roles: await prisma.role.count({ where: { tenantId: tenantA.id } }),
      rolePerms: await prisma.rolePermission.count({
        where: { role: { tenantId: tenantA.id } },
      }),
    };
    expect(after).toEqual(before);
  }, 60000);

  it("le peuplement ne modifie pas Membership.role", async () => {
    const m = await prisma.membership.findUniqueOrThrow({
      where: { id: membershipA.id },
    });
    expect(m.role).toBe("operator");
  });
});
