import { beforeEach, describe, expect, it, vi } from "vitest"

const policyCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: "pol_1",
  ...data,
}))

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    backupPolicy: {
      create: policyCreate,
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    backupTarget: { findFirst: vi.fn() },
    backupDestination: { findFirst: vi.fn() },
    project: { findUnique: vi.fn() },
    cluster: { findFirst: vi.fn() },
  },
}))

const targetFind = vi.fn()
const destinationFind = vi.fn()

vi.mock("../targets.service", () => ({
  backupTargetService: { resolve: vi.fn() },
}))

vi.mock("../destinations.service", () => ({
  backupDestinationService: { resolve: vi.fn() },
}))

vi.mock("../../docker-engine/service", () => ({
  DockerEngineService: { forCluster: vi.fn() },
}))

const { prisma } = await import("../../../lib/prisma")
const { backupPolicyService } = await import("../policies.service")

const base = {
  targetId: "tgt_1",
  destinationId: "dst_1",
  strategyId: "postgres.pg_dump",
  schedule: "manual" as const,
  retentionDays: 30,
  verification: "checksum" as const,
  encryptionMode: "none" as const,
  timeoutSec: 1800,
  maxConcurrency: 1,
  enabled: true,
}

describe("BackupPolicyService.create", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma.backupTarget.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "tgt_1",
      kind: "postgres",
      projectId: "proj_1",
    })
    ;(prisma.backupDestination.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "dst_1",
      protocol: "s3",
    })
    void targetFind
    void destinationFind
  })

  it("crée une policy cohérente", async () => {
    const created = await backupPolicyService.create(base, "t1")
    expect(created.id).toBe("pol_1")
    expect(policyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetId: "tgt_1",
        destinationId: "dst_1",
        strategyId: "postgres.pg_dump",
        retentionDays: 30,
        enabled: true,
      }),
    })
  })

  it("refuse une stratégie incompatible avec la cible", async () => {
    ;(prisma.backupTarget.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "tgt_1",
      kind: "mysql",
      projectId: "proj_1",
    })
    await expect(backupPolicyService.create(base, "t1")).rejects.toThrow(
      /incompatible avec une cible mysql/,
    )
    expect(policyCreate).not.toHaveBeenCalled()
  })

  it("exige un placement pour une destination SMB", async () => {
    ;(prisma.backupDestination.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "dst_1",
      protocol: "smb",
    })
    await expect(backupPolicyService.create(base, "t1")).rejects.toThrow(
      /SMB exige une contrainte de placement/,
    )
  })

  it("accepte SMB avec placement", async () => {
    ;(prisma.backupDestination.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "dst_1",
      protocol: "smb",
    })
    const created = await backupPolicyService.create(
      { ...base, placement: { constraints: ["node.labels.nas==true"], spreadOver: [] } },
      "t1",
    )
    expect(created.id).toBe("pol_1")
  })

  it("refuse une cible d'un autre tenant", async () => {
    ;(prisma.backupTarget.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(backupPolicyService.create(base, "t1")).rejects.toThrow(
      /cible de sauvegarde introuvable/,
    )
  })
})
