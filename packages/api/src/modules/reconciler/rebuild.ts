import { decodeBozandoLabels, LabelKeys } from "@hullbay/shared"
import { DockerEngineService } from "../docker-engine/service"
import { prisma } from "../../lib/prisma"

/**
 * rebuildFromDocker — PILIER DE RÉSILIENCE.
 *
 * Reconstruit les tables Project/Node/Edge depuis les LABELS Docker seuls, au cas
 * où Postgres aurait été perdu/réinitialisé. Docker est la source de vérité
 * redondante (principe directeur : max d'infos dans les labels).
 *
 * Stratégie : lister toutes les ressources gérées -> décoder bozando.spec/edges/
 * canvas -> upsert. Si bozando.spec est illisible, on marque le nœud dégradé
 * (config approximative depuis inspect, à compléter par l'utilisateur).
 */
export async function rebuildFromDocker(clusterId: string): Promise<{ projects: number; nodes: number; edges: number; degraded: number }> {
  //const defaultCluster = await prisma.cluster.findFirstOrThrow({ where: { isDefault: true } })
  const docker = await DockerEngineService.forCluster(clusterId)

  const services = await docker.listManagedServices()
  const networks = await docker.listManagedNetworks()
  const volumes = await docker.listManagedVolumes()

  type Decoded = ReturnType<typeof decodeBozandoLabels>
  const decodedAll: NonNullable<Decoded>[] = []

  for (const s of services) {
    // Les labels d'un service Swarm vivent dans s.Spec.Labels.
    const d = decodeBozandoLabels(s.Spec?.Labels)
    if (d) decodedAll.push(d)
  }
  for (const n of networks) {
    const d = decodeBozandoLabels(n.Labels)
    if (d) decodedAll.push(d)
  }
  for (const v of volumes) {
    const d = decodeBozandoLabels(v.Labels as Record<string, string> | undefined)
    if (d) decodedAll.push(d)
  }

  // Regrouper par projet.
  const byProject = new Map<string, NonNullable<Decoded>[]>()
  for (const d of decodedAll) {
    if (!d.projectId) continue
    const arr = byProject.get(d.projectId) ?? []
    arr.push(d)
    byProject.set(d.projectId, arr)
  }

  let nodes = 0
  let edges = 0
  let degraded = 0

  for (const [projectId, resources] of byProject) {
    const slug = resources[0]?.projectSlug || projectId
    await prisma.project.upsert({
      where: { id: projectId },
      update: { slug, status: "deployed" },
      create: { id: projectId, name: slug, slug, status: "deployed", clusterId },
    })

    // Nœuds.
    const nodeIdByName = new Map<string, string>()
    for (const r of resources) {
      if (r.degraded) degraded++
      await prisma.node.upsert({
        where: { id: r.nodeId },
        update: {
          name: r.nodeName,
          type: r.nodeType,
          posX: r.posX,
          posY: r.posY,
          config: (r.config ?? {}) as object,
          desiredHash: r.desiredHash,
          actualState: "running",
        },
        create: {
          id: r.nodeId,
          projectId,
          name: r.nodeName,
          type: r.nodeType,
          posX: r.posX,
          posY: r.posY,
          config: (r.config ?? {}) as object,
          desiredHash: r.desiredHash,
        },
      })
      nodeIdByName.set(r.nodeName, r.nodeId)
      nodes++
    }

    // Liens (reconstruits depuis bozando.edges des nœuds sources).
    for (const r of resources) {
      for (const e of r.outgoingEdges) {
        const targetId = nodeIdByName.get(e.targetNodeName)
        if (!targetId) continue
        // Évite les doublons : clé logique source+target+kind.
        const existing = await prisma.edge.findFirst({
          where: {
            projectId,
            sourceNodeId: r.nodeId,
            targetNodeId: targetId,
            kind: e.kind,
          },
        })
        if (existing) continue
        await prisma.edge.create({
          data: {
            projectId,
            sourceNodeId: r.nodeId,
            targetNodeId: targetId,
            kind: e.kind,
            config: (e.config ?? undefined) as object | undefined,
          },
        })
        edges++
      }
    }
  }

  return { projects: byProject.size, nodes, edges, degraded }
}

// Réexport pour un éventuel usage CLI.
export { LabelKeys }
