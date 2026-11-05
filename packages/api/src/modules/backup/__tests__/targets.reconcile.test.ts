import { beforeEach, describe, expect, it, vi } from "vitest"

const TARGET = {
  id: "tgt_1",
  projectId: "proj_1",
  tenantId: "tenant_1",
  nodeId: "node_1",
  kind: "postgres",
  name: "orders-db",
  archived: false,
  createdAt: new Date("2026-10-25T10:00:00Z"),
  updatedAt: new Date("2026-10-25T10:00:00Z"),
}

const prismaMock = {
  backupTarget: {
    findFirst: vi.fn(),
    update: vi.fn(
      async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...TARGET,
        ...args.data,
        id: args.where.id,
      }),
    ),
    delete: vi.fn(async () => ({ id: "tgt_1" })),
    create: vi.fn(
      async (args: { data: Record<string, unknown> }) => ({
        ...TARGET,
        ...args.data,
        id: "tgt_2",
      }),
    ),
  },
  backupPolicy: {
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
}

vi.mock("../../../lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@prisma/client", () => ({}))

const { backupTargetService } = await import("../targets.service")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("BackupTargetService.reconcileForNode", () => {
  it("renvoie null sans cible existante (nœud non sauvegardé)", async () => {
    prismaMock.backupTarget.findFirst.mockResolvedValueOnce(null)
    const result = await backupTargetService.reconcileForNode({
      nodeId: "node_1",
      tenantId: "tenant_1",
      projectId: "proj_1",
      expectedKind: "mysql",
      name: "orders-db",
    })
    expect(result).toBeNull()
    expect(prismaMock.backupTarget.update).not.toHaveBeenCalled()
    expect(prismaMock.backupTarget.create).not.toHaveBeenCalled()
  })

  it("renvoie null si le kind attendu correspond déjà (aucun changement)", async () => {
    prismaMock.backupTarget.findFirst.mockResolvedValueOnce(TARGET)
    const result = await backupTargetService.reconcileForNode({
      nodeId: "node_1",
      tenantId: "tenant_1",
      projectId: "proj_1",
      expectedKind: "postgres",
      name: "orders-db",
    })
    expect(result).toBeNull()
    expect(prismaMock.backupTarget.update).not.toHaveBeenCalled()
  })

  it("fige l'ancienne cible (au lieu de la supprimer) et en crée une nouvelle", async () => {
    prismaMock.backupTarget.findFirst.mockResolvedValueOnce(TARGET)
    const result = await backupTargetService.reconcileForNode({
      nodeId: "node_1",
      tenantId: "tenant_1",
      projectId: "proj_1",
      expectedKind: "mysql",
      name: "orders-db",
    })
    expect(result).toEqual({
      oldKind: "postgres",
      newKind: "mysql",
      targetId: "tgt_2",
      reused: false,
      archived: false,
    })
    // Ancienne cible figée, pas supprimée.
    expect(prismaMock.backupTarget.delete).not.toHaveBeenCalled()
    expect(prismaMock.backupTarget.update).toHaveBeenCalledWith({
      where: { id: "tgt_1" },
      data: { archived: true },
    })
    // Ses policies sont désactivées (plus de run auto sur un moteur obsolète).
    expect(prismaMock.backupPolicy.updateMany).toHaveBeenCalledWith({
      where: { targetId: "tgt_1" },
      data: { enabled: false },
    })
    expect(prismaMock.backupTarget.create).toHaveBeenCalledWith({
      data: {
        projectId: "proj_1",
        tenantId: "tenant_1",
        nodeId: "node_1",
        kind: "mysql",
        name: "orders-db",
      },
    })
  })

  it("réutilise une cible figée du nouveau kind (swap-back)", async () => {
    const archivedMysql = { ...TARGET, id: "tgt_m", kind: "mysql", archived: true }
    prismaMock.backupTarget.findFirst
      .mockResolvedValueOnce(TARGET) // cible active (postgres)
      .mockResolvedValueOnce(archivedMysql) // cible existante du kind attendu
    const result = await backupTargetService.reconcileForNode({
      nodeId: "node_1",
      tenantId: "tenant_1",
      projectId: "proj_1",
      expectedKind: "mysql",
      name: "orders-db",
    })
    expect(result).toEqual({
      oldKind: "postgres",
      newKind: "mysql",
      targetId: "tgt_m",
      reused: true,
      archived: false,
    })
    // La cible figée est réactivée, aucune création en doublon.
    expect(prismaMock.backupTarget.update).toHaveBeenCalledWith({
      where: { id: "tgt_m" },
      data: { archived: false, name: "orders-db" },
    })
    expect(prismaMock.backupTarget.create).not.toHaveBeenCalled()
  })
})
