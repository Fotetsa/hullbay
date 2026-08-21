import { describe, it, expect, vi } from "vitest"
import { pruneOrphans, type PruneDeps, type PruneResult } from "../prune-orphans"
import { LabelKeys } from "@hullbay/shared"

function fakeEngine(volumes: { Name: string; Labels?: Record<string, string> }[]) {
  const removedVolumes: string[] = []
  return {
    listManagedServices: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    listManagedNetworks: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    listManagedVolumes: vi.fn(async () => volumes),
    removeService: vi.fn(),
    removeNetwork: vi.fn(),
    removeVolume: vi.fn(async (name: string) => {
      removedVolumes.push(name)
    }),
    removedVolumes,
  }
}

function deps(
  volume: { Name: string; Labels?: Record<string, string> },
  known: string[] = [],
  overrides: Partial<PruneDeps> = {}
): PruneDeps {
  const engine = fakeEngine([volume])
  return {
    clusterIds: async () => ["c1"],
    engineForCluster: async () => engine as never,
    knownProjectIds: async () => new Set(known),
    ...overrides,
  }
}

describe("pruneOrphans — garde rétention data (S3-09)", () => {
  it("volume de données d'un projet supprimé → JAMAIS candidat (dry-run)", async () => {
    const volume = {
      Name: "boz_proj-a_catalog-data",
      Labels: {
        [LabelKeys.managed]: "true",
        [LabelKeys.projectId]: "p-gone",
        [LabelKeys.dbData]: "true",
      },
    }
    const res: PruneResult = await pruneOrphans(false, deps(volume, []))
    expect(res.candidates).toHaveLength(0)
    expect(res.candidates.some((c) => c.kind === "volume")).toBe(false)
  })

  it("volume de données d'un projet vivant → jamais candidat", async () => {
    const volume = {
      Name: "boz_proj-a_catalog-data",
      Labels: {
        [LabelKeys.managed]: "true",
        [LabelKeys.projectId]: "p1",
        [LabelKeys.dbData]: "true",
      },
    }
    const res = await pruneOrphans(false, deps(volume, ["p1"]))
    expect(res.candidates).toHaveLength(0)
  })

  it("volume normal d'un projet supprimé → candidat", async () => {
    const volume = {
      Name: "boz_orphan_cache",
      Labels: { [LabelKeys.managed]: "true", [LabelKeys.projectId]: "p-gone" },
    }
    const res = await pruneOrphans(false, deps(volume, []))
    expect(res.candidates).toEqual([
      expect.objectContaining({ kind: "volume", name: "boz_orphan_cache" }),
    ])
  })

  it("apply=true supprime le normal, JAMAIS le volume de données", async () => {
    const volumeData = {
      Name: "boz_proj-a_catalog-data",
      Labels: {
        [LabelKeys.managed]: "true",
        [LabelKeys.projectId]: "p-gone",
        [LabelKeys.dbData]: "true",
      },
    }
    const volumeNormal = {
      Name: "boz_proj-a_cache",
      Labels: { [LabelKeys.managed]: "true", [LabelKeys.projectId]: "p-gone" },
    }
    const engine = fakeEngine([volumeData, volumeNormal])
    const res = await pruneOrphans(true, {
      clusterIds: async () => ["c1"],
      engineForCluster: async () => engine as never,
      knownProjectIds: async () => new Set<string>(),
    })
    expect(engine.removedVolumes).toEqual(["boz_proj-a_cache"])
    expect(res.removed.map((r) => r.name)).toEqual(["boz_proj-a_cache"])
    // Le volume de données est EXCLU de la sélection et JAMAIS supprimé.
    expect(res.candidates.some((c) => c.name === "boz_proj-a_catalog-data")).toBe(false)
    expect(res.removed.some((c) => c.name === "boz_proj-a_catalog-data")).toBe(false)
    expect(res.candidates.some((c) => c.name === "boz_proj-a_cache")).toBe(true)
  })

  it("le label système bozando.system reste intouchable (pas de régression)", async () => {
    const volume = {
      Name: "boz_system_x",
      Labels: { [LabelKeys.managed]: "true", [LabelKeys.system]: "true" },
    }
    const res = await pruneOrphans(false, deps(volume, []))
    expect(res.candidates).toHaveLength(0)
  })
})