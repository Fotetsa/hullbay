import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const store: Record<string, unknown>[] = []

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value)
}

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    backupDestination: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `dest_${store.length + 1}`,
          projectId: null,
          capabilitiesJson: null,
          lastTestedAt: null,
          createdAt: new Date("2026-10-25T10:00:00Z"),
          updatedAt: new Date("2026-10-25T10:00:00Z"),
          ...data,
        }
        store.push(row)
        return row
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.filter((row) => matches(row, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          store.find((row) => matches(row, where)) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string }
          data: Record<string, unknown>
        }) => {
          const row = store.find((candidate) => candidate.id === where.id)
          if (!row) throw new Error("introuvable")
          for (const [key, value] of Object.entries(data)) {
            row[key] = value === Prisma.DbNull ? null : value
          }
          return row
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = store.findIndex((row) => row.id === where.id)
        return store.splice(index, 1)[0]
      }),
    },
    project: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.id === "proj-1" && where.tenantId === "t1" ? { id: "proj-1" } : null,
      ),
    },
  },
}))

const { backupDestinationService } = await import("../destinations.service")

const s3Config = {
  protocol: "s3" as const,
  bucket: "backups",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "super-secret-key",
  region: "eu-west-3",
  useTls: true,
  pathStyle: false,
}

describe("BackupDestinationService", () => {
  beforeEach(() => {
    store.length = 0
    vi.clearAllMocks()
  })

  it("chiffre la configuration et ne l'expose jamais", async () => {
    const view = await backupDestinationService.create(
      { name: "prod", basePath: "hullbay", config: s3Config },
      "t1",
    )

    const row = store[0] as { configEncrypted: string }
    expect(row.configEncrypted).not.toContain("super-secret-key")
    expect(row.configEncrypted).not.toContain("AKIAEXAMPLE")

    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain("super-secret-key")
    expect(serialized).not.toContain("AKIAEXAMPLE")
    expect(view).toMatchObject({ name: "prod", protocol: "s3", basePath: "hullbay" })
  })

  it("déchiffre uniquement en interne pour le runner", async () => {
    const view = await backupDestinationService.create(
      { name: "prod", basePath: "hullbay", config: s3Config },
      "t1",
    )
    const resolved = await backupDestinationService.resolve(view.id, "t1")
    expect(resolved).toMatchObject({
      protocol: "s3",
      basePath: "hullbay",
      config: { secretAccessKey: "super-secret-key" },
    })
  })

  it("isole les destinations par tenant", async () => {
    await backupDestinationService.create(
      { name: "prod", basePath: "hullbay", config: s3Config },
      "t1",
    )
    await expect(backupDestinationService.list("t2")).resolves.toEqual([])
    const created = (await backupDestinationService.list("t1"))[0]!
    await expect(backupDestinationService.get(created.id, "t2")).rejects.toThrow(
      /introuvable/,
    )
  })

  it("refuse un projet d'un autre tenant", async () => {
    await expect(
      backupDestinationService.create(
        { name: "prod", basePath: "hullbay", projectId: "proj-2", config: s3Config },
        "t1",
      ),
    ).rejects.toThrow(/projet introuvable/)
  })

  it("invalide le probe quand les credentials changent", async () => {
    const view = await backupDestinationService.create(
      { name: "prod", basePath: "hullbay", config: s3Config },
      "t1",
    )
    await backupDestinationService.recordProbe(view.id, "t1", {
      read: true,
      write: true,
      delete: true,
      move: true,
      checksum: true,
      atomicCommit: true,
      serverSideEncryption: false,
    })
    const afterProbe = await backupDestinationService.get(view.id, "t1")
    expect(afterProbe.capabilities?.write).toBe(true)

    const updated = await backupDestinationService.update(view.id, "t1", {
      config: { ...s3Config, secretAccessKey: "new-secret" },
    })
    expect(updated.capabilities).toBeNull()
    expect(updated.lastTestedAt).toBeNull()
  })

  it("supprime une destination du tenant", async () => {
    const view = await backupDestinationService.create(
      { name: "prod", basePath: "hullbay", config: s3Config },
      "t1",
    )
    await backupDestinationService.remove(view.id, "t1")
    await expect(backupDestinationService.list("t1")).resolves.toEqual([])
  })
})
