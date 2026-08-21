import { describe, it, expect, vi } from "vitest"
import { runWorkflow } from "../../lib/workflow"
import { volumesStep } from "../deploy-project"
import type { DeployInput, DeployShared } from "../deploy-project"
import { LabelKeys } from "@hullbay/shared"

function baseGraph() {
  return {
    id: "p1",
    name: "projet A",
    slug: "proj-a",
    clusterId: "c1",
    status: "draft",
    // Aucun nœud volume → TOUT volume managé du projet hors graphe est orphelin.
    nodes: [
      {
        id: "n_web",
        projectId: "p1",
        type: "container",
        name: "web",
        posX: 0,
        posY: 0,
        config: { image: "nginx", tag: "1.27", replicas: 1 },
      },
    ],
    edges: [],
  }
}

function fakeEngine(volumes: { Name: string; Labels?: Record<string, string> }[]) {
  const removed: string[] = []
  return {
    listManagedVolumes: vi.fn(async () => volumes),
    removeVolume: vi.fn(async (name: string) => {
      removed.push(name)
    }),
    removed,
  }
}

function sharedWith(engine: ReturnType<typeof fakeEngine>): DeployShared {
  return {
    log: [],
    networkIdByNodeId: new Map(),
    createdServiceIds: [],
    createdNetworkIds: [],
    createdGateways: [],
    db: { graph: baseGraph() as never, ownership: new Map(), generatedSecrets: [] },
    deployed: new Map(),
    engine: engine as never,
    reconciler: { plan: async () => ({ actions: [] }) } as never,
  }
}

describe("volumesStep — vols orphelins retenus par la garde data (S3-08)", () => {
  it("retire les orphelins normaux, JAMAIS le volume de données", async () => {
    const engine = fakeEngine([
      {
        Name: "boz_proj-a_cache",
        Labels: {
          [LabelKeys.managed]: "true",
          [LabelKeys.projectId]: "p1",
        },
      },
      {
        Name: "boz_proj-a_catalog-data",
        Labels: {
          [LabelKeys.managed]: "true",
          [LabelKeys.projectId]: "p1",
          [LabelKeys.dbData]: "true",
        },
      },
      {
        Name: "boz_system_x",
        Labels: { [LabelKeys.managed]: "true", [LabelKeys.system]: "true" },
      },
      {
        Name: "boz_foreign_cache",
        Labels: { [LabelKeys.managed]: "true", [LabelKeys.projectId]: "p2" },
      },
    ])
    const shared = sharedWith(engine)

    const res = await runWorkflow(
      "t",
      [volumesStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )

    expect(res.ok).toBe(true)
    // Un seul orphelin supprimé : le volume normal du projet.
    expect(engine.removed).toEqual(["boz_proj-a_cache"])
    expect(shared.log.join("\n")).toContain("volume boz_proj-a_cache supprimé (hors graphe)")
    expect(shared.log.join("\n")).not.toContain("catalog-data")
  })

  it("volume de données retiré du graphe → toujours conservé au redeploy", async () => {
    const engine = fakeEngine([
      {
        Name: "boz_proj-a_catalog-data",
        Labels: {
          [LabelKeys.managed]: "true",
          [LabelKeys.projectId]: "p1",
          [LabelKeys.dbData]: "true",
        },
      },
    ])
    const shared = sharedWith(engine)
    const res = await runWorkflow(
      "t",
      [volumesStep],
      { graph: baseGraph() as DeployInput["graph"] } as DeployInput,
      {},
      shared as unknown as Record<string, unknown>,
    )
    expect(res.ok).toBe(true)
    expect(engine.removed).toEqual([])
  })
})