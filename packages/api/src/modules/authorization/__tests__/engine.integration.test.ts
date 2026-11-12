import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createAuthorization } from "../authorization.service";
import {
  PrismaGrantRepository,
  PrismaResourceRepository,
} from "../repositories/prisma";
import { RESOURCE_CATALOG } from "../catalog/resource-catalog";
import { testSubject } from "./test-subject";
import { subjectFromSession } from "../subject";
import { VIEWER_KEYS as VIEWER, OPERATOR_KEYS as OPERATOR } from "./preset-matrix"

const prisma = new PrismaClient();
const authz = createAuthorization({
  grants: new PrismaGrantRepository(prisma),
  resources: new PrismaResourceRepository(prisma),
});
const suffix = Date.now();

let tA: { id: string };
let tB: { id: string };
let clusterA: { id: string };
let clusterB: { id: string };
let projA1: { id: string };
let projA2: { id: string };
const NAMES = ["owner", "operator", "viewer", "dev", "teamdev"] as const;
type UserName = (typeof NAMES)[number];
const users = {} as Record<UserName, string>;

beforeAll(async () => {
  tA = await prisma.tenant.create({
    data: { name: "A", slug: `eng-a-${suffix}` },
  });
  tB = await prisma.tenant.create({
    data: { name: "B", slug: `eng-b-${suffix}` },
  });
  for (const name of NAMES) {
    const u = await prisma.user.create({
      data: { email: `eng-${name}-${suffix}@test.local` },
    });
    users[name] = u.id;
  }
  await prisma.membership.createMany({
    data: [
      { userId: users.owner, tenantId: tA.id, role: "owner" },
      { userId: users.operator, tenantId: tA.id, role: "operator" },
      { userId: users.viewer, tenantId: tA.id, role: "viewer" },
      { userId: users.dev, tenantId: tA.id, role: "viewer" },
      { userId: users.teamdev, tenantId: tA.id, role: "viewer" },
    ],
  });
  clusterA = await prisma.cluster.create({
    data: { tenantId: tA.id, name: "ca", dockerHost: "", caddyAdminUrl: "" },
  });
  clusterB = await prisma.cluster.create({
    data: { tenantId: tB.id, name: "cb", dockerHost: "", caddyAdminUrl: "" },
  });
  projA1 = await prisma.project.create({
    data: {
      tenantId: tA.id,
      clusterId: clusterA.id,
      name: "p1",
      slug: `p1-${suffix}`,
    },
  });
  projA2 = await prisma.project.create({
    data: {
      tenantId: tA.id,
      clusterId: clusterA.id,
      name: "p2",
      slug: `p2-${suffix}`,
    },
  });
  execSync("node src/modules/authorization/scripts/seed-authorization.mjs", {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}, 120000);

afterAll(async () => {
  if (tA) await prisma.tenant.delete({ where: { id: tA.id } }).catch(() => {})
  if (tB) await prisma.tenant.delete({ where: { id: tB.id } }).catch(() => {})
  await prisma.user.deleteMany({ where: { email: { contains: String(suffix) } } }).catch(() => {})
  await prisma.$disconnect()
})

async function allowedKeys(userId: string) {
  const out: string[] = [];
  for (const key of RESOURCE_CATALOG.keys()) {
    const d = await authz.can({
      subject: testSubject(userId, tA.id),
      action: key,
    });
    if (d.allowed) out.push(key);
  }
  return out.sort();
}

describe("catalogue et base", () => {
  it("le catalogue correspond exactement aux permissions seedées", async () => {
    const rows = await prisma.permission.findMany({ select: { key: true } });
    const dbKeys = rows
      .map((r) => r.key)
      .filter((k) => !k.startsWith("test."))
      .sort();
    expect(dbKeys).toEqual([...RESOURCE_CATALOG.keys()].sort());
  });
});

describe("les presets historiques reproduisent la matrice (via le repli legacy)", () => {
  it("Viewer : exactement 4 permissions", async () => {
    expect(await allowedKeys(users.viewer)).toEqual([...VIEWER].sort());
  });
  it("Operator : exactement 25 permissions", async () => {
    expect(await allowedKeys(users.operator)).toEqual([...OPERATOR].sort());
  });
  it("Owner : les 60 permissions", async () => {
    expect((await allowedKeys(users.owner)).length).toBe(60);
  });
});

describe("isolation entre tenants", () => {
  it("un utilisateur du tenant A n'a aucun accès dans le tenant B", async () => {
    const d = await authz.can({
      subject: testSubject(users.owner, tB.id),
      action: "cluster.read",
    });
    expect(d.reason).toBe("no_membership");
  });
  it("une ressource du tenant B est refusée pour un sujet du tenant A", async () => {
    const d = await authz.can({
      subject: testSubject(users.owner, tA.id),
      action: "cluster.read",
      resource: { type: "cluster", id: clusterB.id },
    });
    expect(d.reason).toBe("tenant_mismatch");
  });
});

describe("droits limités à une ressource", () => {
  it("rôle direct limité à un projet", async () => {
    const p = await prisma.permission.findUniqueOrThrow({
      where: { key: "project.deploy" },
    });
    const role = await prisma.role.create({
      data: { tenantId: tA.id, name: "Dev P1" },
    });
    await prisma.rolePermission.create({
      data: {
        roleId: role.id,
        permissionId: p.id,
        scopeType: "project",
        scopeId: projA1.id,
      },
    });
    await prisma.membership.update({
      where: { userId_tenantId: { userId: users.dev, tenantId: tA.id } },
      data: { roleId: role.id },
    });
    const subject = testSubject(users.dev, tA.id);
    const ok = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: projA1.id },
    });
    const ko = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: projA2.id },
    });
    expect(ok.allowed).toBe(true);
    expect(ok.sources[0]?.via).toBe("direct");
    expect(ko.allowed).toBe(false);
  });

  it("rôle via une équipe, périmètre d'attribution sur un projet", async () => {
    const preset = await prisma.role.findUniqueOrThrow({
      where: { tenantId_name: { tenantId: tA.id, name: "Operator" } },
    });
    const team = await prisma.team.create({
      data: { tenantId: tA.id, name: "Backend" },
    });
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_tenantId: { userId: users.teamdev, tenantId: tA.id } },
    });
    await prisma.teamMember.create({
      data: { tenantId: tA.id, teamId: team.id, membershipId: membership.id },
    });
    await prisma.teamRole.create({
      data: {
        tenantId: tA.id,
        teamId: team.id,
        roleId: preset.id,
        scopeType: "project",
        scopeId: projA1.id,
      },
    });
    const subject = testSubject(users.teamdev, tA.id);
    const ok = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: projA1.id },
    });
    const ko = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: projA2.id },
    });
    expect(ok.allowed).toBe(true);
    expect(ok.sources[0]).toMatchObject({ via: "team" });
    expect(ko.allowed).toBe(false);
    // Le même utilisateur ne peut pas administrer le cluster.
    const c = await authz.can({
      subject,
      action: "cluster.update",
      resource: { type: "cluster", id: clusterA.id },
    });
    expect(c.allowed).toBe(false);
  });

  it("le repository charge un nœud avec son projet et son cluster comme ancêtres", async () => {
    const node = await prisma.node.create({
      data: {
        projectId: projA1.id,
        type: "container",
        name: "web",
        posX: 0,
        posY: 0,
        config: {},
      },
    });
    const rec = await new PrismaResourceRepository(prisma).load(
      "node",
      node.id,
    );
    expect(rec).toMatchObject({
      tenantId: tA.id,
      parents: { project: projA1.id, cluster: clusterA.id },
    });
  });
});

describe("le tenant du Subject vient de la session authentifiée", () => {
  it("un tenantId fourni par le client ne donne aucun accès au tenant B", async () => {
    const session = { sub: users.owner, tenantId: tA.id };
    const clientInput = { tenantId: tB.id };

    const subject = subjectFromSession(session);
    expect(subject.tenantId).toBe(tA.id);

    const forged = await authz.can({
      subject: testSubject(users.owner, clientInput.tenantId),
      action: "cluster.read",
    });
    expect(forged).toMatchObject({ allowed: false, reason: "no_membership" });

    const crossResource = await authz.can({
      subject,
      action: "cluster.read",
      resource: { type: "cluster", id: clusterB.id },
    });
    expect(crossResource).toMatchObject({
      allowed: false,
      reason: "tenant_mismatch",
    });
  });
});
