import { describe, it, expect } from "vitest"
import { ReconcilerService } from "../service.js"
import type { ProjectGraph } from "@hullbay/shared"
import type { DockerEngineService } from "../../docker-engine/service"

const graph: ProjectGraph = {
  id: "p1",
  name: "projet",
  slug: "proj-a",
  clusterId: "c1",
  status: "deployed",
  nodes: [],
  edges: [],
}

function fakeEngine(
  volumes: { Name: string; Labels: Record<string, string> }[],
  secrets: { name: string; labels: Record<string, string> }[] = []
): {
  engine: DockerEngineService
  removedVolumes: string[]
  removedSecrets: string[]
} {
  const removedVolumes: string[] = []
  const removedSecrets: string[] = []
  const engine = {
    listProjectServices: async () => [],
    listManagedNetworks: async () => [],
    listManagedVolumes: async () => volumes,
    listManagedSecrets: async () => secrets,
    removeVolume: async (name: string) => {
      removedVolumes.push(name)
    },
    removeSecret: async (name: string) => {
      removedSecrets.push(name)
    },
    removeService: async () => {},
    listServiceTasks: async () => [],
    removeNetwork: async () => {},
  } as unknown as DockerEngineService
  return { engine, removedVolumes, removedSecrets }
}

const exposureMock = { deleteRoute: async () => {} }
// exposureService est appelé par destroy pour les passerelles ; aucun ici.

export function destroyWithVolumes(volumes: { Name: string; Labels: Record<string, string> }[]) {
  const { engine, removedVolumes, removedSecrets } = fakeEngine(volumes)
  const reconciler = new ReconcilerService(engine)
  return { reconciler, removedVolumes, removedSecrets }
}

describe("ReconcilerService.destroy — garde rétention (S3-03)", () => {
  it("supprime les volumes managés normaux", async () => {
    const { reconciler, removedVolumes } = destroyWithVolumes([
      { Name: "boz_proj-a_data", Labels: { "bozando.managed": "true", "bozando.projectId": "p1" } },
    ])
    const log = await reconciler.destroy(graph)
    expect(removedVolumes).toEqual(["boz_proj-a_data"])
    expect(log.join("\n")).toContain("supprimé")
  })

  it("conserve les volumes de données (bozando.database.data=true)", async () => {
    const { reconciler, removedVolumes } = destroyWithVolumes([
      {
        Name: "boz_proj-a_catalog-data",
        Labels: {
          "bozando.managed": "true",
          "bozando.projectId": "p1",
          "bozando.database.data": "true",
        },
      },
    ])
    const log = await reconciler.destroy(graph)
    expect(removedVolumes).toEqual([])
    expect(log.join("\n")).toContain("données retenues")
  })

  it("conserve les données même en présence de volumes normaux", async () => {
    const { reconciler, removedVolumes } = destroyWithVolumes([
      { Name: "boz_proj-a_cache", Labels: { "bozando.managed": "true", "bozando.projectId": "p1" } },
      {
        Name: "boz_proj-a_catalog-data",
        Labels: {
          "bozando.managed": "true",
          "bozando.projectId": "p1",
          "bozando.database.data": "true",
        },
      },
    ])
    await reconciler.destroy(graph)
    expect(removedVolumes).toEqual(["boz_proj-a_cache"])
  })

  it("ignore les volumes d'un autre projet", async () => {
    const { reconciler, removedVolumes } = destroyWithVolumes([
      { Name: "boz_other_data", Labels: { "bozando.managed": "true", "bozando.projectId": "p2" } },
    ])
    await reconciler.destroy(graph)
    expect(removedVolumes).toEqual([])
  })

  it("S5-10 : rétention LIVE — toggle retain off→on entre 2 deploys (sans relabel Docker)", async () => {
    // Déployé avec retain=false, relabellisé au premier destroy : le volume n'a PAS
    // le label data. Mais la config (décision live) dit retain=true → conservé.
    const { reconciler, removedVolumes } = destroyWithVolumes([
      {
        Name: "boz_proj-a_catalog-data-1",
        Labels: { "bozando.managed": "true", "bozando.projectId": "p1" },
      },
    ])
    const log = await reconciler.destroy(graph, {
      retainedVolumeNames: new Set(["boz_proj-a_catalog-data-1"]),
    })
    expect(removedVolumes).toEqual([])
    expect(log.join("\n")).toContain("rétention définie dans la config")
  })

  it("S5-10 : toggle on→off honoré — un volume labellisé data est détruit si la config dit non", async () => {
    const { reconciler, removedVolumes } = destroyWithVolumes([
      {
        Name: "boz_proj-a_catalog-data-1",
        Labels: {
          "bozando.managed": "true",
          "bozando.projectId": "p1",
          "bozando.database.data": "true",
        },
      },
    ])
    await reconciler.destroy(graph, {
      retainedVolumeNames: new Set(),
      managedDataVolumeNames: new Set(["boz_proj-a_catalog-data-1"]),
    })
    // Le graphe (décision live) prime sur le label : retain=false explicite.
    expect(removedVolumes).toEqual(["boz_proj-a_catalog-data-1"])
  })

  it("S5-10 : les volumes de données SANS décision live restent protégés par label (orphelins)", async () => {
    // Volume retiré du graphe : rien ne peut exprimer une décision -> garde label.
    const { reconciler, removedVolumes } = destroyWithVolumes([
      {
        Name: "boz_proj-a_catalog-data",
        Labels: {
          "bozando.managed": "true",
          "bozando.projectId": "p1",
          "bozando.database.data": "true",
        },
      },
    ])
    await reconciler.destroy(graph)
    expect(removedVolumes).toEqual([])
  })

  it("S5-10 : purge les secrets de configuration générés au destroy", async () => {
    const { engine, removedSecrets } = fakeEngine([], [
      {
        name: "catalog-replication-abc12345",
        labels: {
          "bozando.managed": "true",
          "bozando.database.generated": "true",
          "bozando.projectId": "p1",
        },
      },
      {
        name: "autre-projet",
        labels: {
          "bozando.managed": "true",
          "bozando.database.generated": "true",
          "bozando.projectId": "p2",
        },
      },
    ])
    const reconciler = new ReconcilerService(engine)
    const log = await reconciler.destroy(graph)
    expect(removedSecrets).toContain("catalog-replication-abc12345")
    expect(removedSecrets).not.toContain("autre-projet")
    expect(log.join("\n")).toContain("secret généré")
  })
})