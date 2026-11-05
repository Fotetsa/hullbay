import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const targetRow = {
  id: "tgt_1",
  projectId: "proj_1",
  tenantId: "tenant_1",
  nodeId: "node_1",
  kind: "volume",
  name: "uploads",
  createdAt: new Date("2026-10-25T10:00:00Z"),
  updatedAt: new Date("2026-10-25T10:00:00Z"),
}

let nodeLabels: Record<string, string> = {}

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    backupTarget: {
      findFirst: vi.fn(async () => targetRow),
    },
    node: {
      findFirst: vi.fn(async () => ({
        id: "node_1",
        projectId: "proj_1",
        name: "uploads",
        type: "volume",
        config: {
          driver: "local",
          driverOpts: {},
          labels: nodeLabels,
          external: false,
        },
        project: { slug: "shop" },
      })),
    },
  },
}))

const { backupTargetService } = await import("../targets.service")

describe("BackupTargetService — garde volume de données", () => {
  beforeEach(() => {
    nodeLabels = {}
    delete process.env.BACKUP_ALLOW_DATABASE_VOLUME
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.BACKUP_ALLOW_DATABASE_VOLUME
  })

  it("marque un volume labelisé bozando.database.data=true", async () => {
    nodeLabels = { "bozando.database.data": "true" }
    const resolved = await backupTargetService.resolve("tgt_1", "tenant_1")
    expect(resolved.target.isDataVolume).toBe(true)
    expect(resolved.target.allowDataVolume).toBe(false)
  })

  it("ne marque pas un volume applicatif ordinaire", async () => {
    nodeLabels = { "bozando.database.data": "false" }
    const resolved = await backupTargetService.resolve("tgt_1", "tenant_1")
    expect(resolved.target.isDataVolume).toBe(false)
  })

  it("n'autorise l'override que sur flag opérateur explicite et le consigne", async () => {
    nodeLabels = { "bozando.database.data": "true" }
    process.env.BACKUP_ALLOW_DATABASE_VOLUME = "true"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const resolved = await backupTargetService.resolve("tgt_1", "tenant_1")

    expect(resolved.target.allowDataVolume).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("override explicite"))
  })

  it("n'avertit pas sans volume de données", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await backupTargetService.resolve("tgt_1", "tenant_1")
    expect(warn).not.toHaveBeenCalled()
  })
})
