import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { acquireLease, releaseLease } from "../engine/lease"

/**
 * Test de concurrence réel : deux acquisitions simultanées sur la même policy.
 * Sans lease, deux instances Hullbay lanceraient le même backup.
 */

const prisma = new PrismaClient()
const suffix = Date.now()

let policyId: string
let tenantId: string
let clusterId: string
let projectId: string
let nodeId: string
let targetId: string
let destinationId: string

beforeAll(async () => {
  const tenant = await prisma.tenant.create({
    data: { name: "Lease", slug: `lease-${suffix}` },
  })
  tenantId = tenant.id
  const cluster = await prisma.cluster.create({
    data: {
      tenantId,
      name: `lease-cluster-${suffix}`,
      dockerHost: "",
      caddyAdminUrl: "",
    },
  })
  clusterId = cluster.id
  const project = await prisma.project.create({
    data: {
      tenantId,
      clusterId,
      name: "lease-project",
      slug: `lease-project-${suffix}`,
    },
  })
  projectId = project.id
  const node = await prisma.node.create({
    data: {
      projectId,
      type: "database",
      name: "db",
      posX: 0,
      posY: 0,
      config: { engine: "postgres", version: "16" },
    },
  })
  nodeId = node.id
  const target = await prisma.backupTarget.create({
    data: { projectId, tenantId, nodeId, kind: "postgres", name: "db" },
  })
  targetId = target.id
  const destination = await prisma.backupDestination.create({
    data: {
      tenantId,
      name: "dest",
      protocol: "s3",
      configEncrypted: "x",
      basePath: "hullbay",
    },
  })
  destinationId = destination.id
  const policy = await prisma.backupPolicy.create({
    data: {
      targetId,
      destinationId,
      strategyId: "postgres.pg_dump",
      retentionDays: 30,
    },
  })
  policyId = policy.id
}, 60_000)

afterAll(async () => {
  await prisma.backupPolicy.deleteMany({ where: { id: policyId } }).catch(() => undefined)
  await prisma.backupTarget.deleteMany({ where: { id: targetId } }).catch(() => undefined)
  await prisma.backupDestination.deleteMany({ where: { id: destinationId } }).catch(() => undefined)
  await prisma.node.deleteMany({ where: { id: nodeId } }).catch(() => undefined)
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => undefined)
  await prisma.cluster.deleteMany({ where: { id: clusterId } }).catch(() => undefined)
  await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined)
  await prisma.$disconnect()
})

describe("lease de policy", () => {
  it("une seule des deux acquisitions concurrentes réussit", async () => {
    const results = await Promise.all([
      acquireLease(policyId, { owner: "instance-a" }),
      acquireLease(policyId, { owner: "instance-b" }),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("libère le lease pour l'instance propriétaire", async () => {
    const owner = (await prisma.backupPolicy.findUnique({ where: { id: policyId } }))!
      .lockedBy!
    await releaseLease(policyId, "mauvaise-instance")
    expect(
      (await prisma.backupPolicy.findUnique({ where: { id: policyId } }))!.lockedBy,
    ).toBe(owner)

    await releaseLease(policyId, owner)
    expect(
      (await prisma.backupPolicy.findUnique({ where: { id: policyId } }))!.lockedBy,
    ).toBeNull()
  })

  it("reprend un lease expiré", async () => {
    await prisma.backupPolicy.update({
      where: { id: policyId },
      data: { lockedBy: "instance-morte", lockExpiresAt: new Date(Date.now() - 1000) },
    })
    expect(await acquireLease(policyId, { owner: "instance-c" })).toBe(true)
  })

  it("refuse une policy désactivée", async () => {
    await releaseLease(policyId, "instance-c")
    await prisma.backupPolicy.update({ where: { id: policyId }, data: { enabled: false } })
    expect(await acquireLease(policyId, { owner: "instance-d" })).toBe(false)
  })
})
