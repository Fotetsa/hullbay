import {
  computeDesiredHash,
  decodeBozandoLabels,
  decodeDatabaseParent,
  LabelKeys,
} from "@hullbay/shared"
import { DockerEngineService } from "../docker-engine/service"
import { prisma } from "../../lib/prisma"

/**
 * rebuildFromDocker — PILIER DE RÉSILIENCE.
 *
 * Reconstruit les tables Project/Node/Edge depuis les LABELS Docker seuls, au cas
 * où Postgres aurait été perdu/réinitialisé. Docker est la source de vérité
 * redondante (principe directeur : max d'infos dans les labels).
 *
 * NŒUDS DATABASE : les ressources générées (membres/consensus/réseau/volume)
 * portent `bozando.database.*` dont la CONFIG PARENT encodée. Elles sont
 * synthétiques et JAMAIS persistées : le nœud `database` de composition est
 * reconstruit depuis ces labels (un seul par parent), puis les membres
 * ré-attribués à l'état réel par l'observer. Les edges (app→db) vivent sur les
 * labels des nœuds applicatifs — résolus par nom ici.
 *
 * Si bozando.spec / bozando.database.parentConfig est illisible, on marque le
 * nœud dégradé (config approximative depuis inspect, à compléter).
 */
export async function rebuildFromDocker(clusterId: string): Promise<{ projects: number; nodes: number; edges: number; degraded: number }> {
  const docker = await DockerEngineService.forCluster(clusterId)

  const services = await docker.listManagedServices()
  const networks = await docker.listManagedNetworks()
  const volumes = await docker.listManagedVolumes()

  type Decoded = ReturnType<typeof decodeBozandoLabels>
  const decodedAll: NonNullable<Decoded>[] = []

  interface ParentCandidate {
    projectId: string
    parentNodeId: string
    parentNodeName: string
    parentConfig: Record<string, unknown> | null
    posX: number
    posY: number
  }
  // Parents database reconstruits depuis les labels d'ownership des ressources
  // générées — un par parentNodeId, position dérivée des membres (offset +24).
  const parents = new Map<string, ParentCandidate>()
  // NodeIds synthétiques des ressources générées (à NE JAMAIS persister).
  const ownedNodeIds = new Set<string>()

  const collect = (raw: Record<string, string> | undefined) => {
    const d = decodeBozandoLabels(raw)
    if (d) decodedAll.push(d)
    const p = decodeDatabaseParent(raw)
    if (p) {
      // Last-wins, sauf si la config existante est valide et la nouvelle illisible :
      // un membre au label d'ownership altéré ne doit pas écraser une bonne config.
      const existing: ParentCandidate | undefined = parents.get(p.parentNodeId)
      const syntheticId = raw?.[LabelKeys.nodeId]
      if (existing && existing.parentConfig !== null && p.parentConfig === null) {
        if (syntheticId) ownedNodeIds.add(syntheticId)
        return
      }
      const memberX = Number(raw?.[LabelKeys.canvasX] ?? 0)
      const memberY = Number(raw?.[LabelKeys.canvasY] ?? 0)
      parents.set(p.parentNodeId, {
        projectId: raw?.[LabelKeys.projectId] ?? "",
        parentNodeId: p.parentNodeId,
        parentNodeName: p.parentNodeName,
        parentConfig: p.parentConfig,
        posX: memberX - 24,
        posY: memberY - 24,
      })
      if (syntheticId) ownedNodeIds.add(syntheticId)
    }
  }
  for (const s of services) collect(s.Spec?.Labels)
  for (const n of networks) collect(n.Labels)
  for (const v of volumes) collect(v.Labels as Record<string, string> | undefined)

  // Regrouper par projet.
  const byProject = new Map<string, NonNullable<Decoded>[]>()
  for (const d of decodedAll) {
    if (!d.projectId) continue
    const arr = byProject.get(d.projectId) ?? []
    arr.push(d)
    byProject.set(d.projectId, arr)
  }
  // Parents database par projet (pré-chargés depuis les membres).
  const parentsByProject = new Map<string, Map<string, ParentCandidate>>()
  for (const p of parents.values()) {
    if (!p.projectId) continue
    let arr = parentsByProject.get(p.projectId)
    if (!arr) {
      arr = new Map()
      parentsByProject.set(p.projectId, arr)
    }
    arr.set(p.parentNodeId, p)
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

    const projectParents = parentsByProject.get(projectId) ?? new Map()

    // Nœuds.
    const nodeIdByName = new Map<string, string>()

    // 1. Nœuds database parents : reconstruits depuis les labels d'ownership
    //    (CONFIG ENCODÉE PARENT). Jamais de membre synthétique persisté.
    //    Config illisible → ne PAS écraser une config existante valide en base :
    //    upsert update sans config (conservateur), create dégradé si absent.
    for (const p of projectParents.values()) {
      if (p.parentConfig === null) degraded++
      const base = { name: p.parentNodeName, type: "database", posX: p.posX, posY: p.posY }
      const cfg = p.parentConfig
      await prisma.node.upsert({
        where: { id: p.parentNodeId },
        update: {
          ...base,
          ...(cfg
            ? {
                config: cfg,
                desiredHash: computeDesiredHash({ type: "database", name: p.parentNodeName, config: cfg }),
              }
            : {}),
          actualState: "running",
        },
        create: {
          id: p.parentNodeId,
          projectId,
          ...base,
          config: cfg ?? ({} as object),
          desiredHash: computeDesiredHash({
            type: "database",
            name: p.parentNodeName,
            config: cfg ?? {},
          }),
        },
      })
      nodeIdByName.set(p.parentNodeName, p.parentNodeId)
      nodes++
    }

    // 2. Nœuds réguliers (les ressources générées database sont synthétiques :
    //    positionnées uniquement via l'observer sur le parent, jamais persistées).
    for (const r of resources) {
      if (ownedNodeIds.has(r.nodeId)) continue
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

    // Liens (reconstruits depuis bozando.edges des nœuds sources — y compris les
    // edges app→database résolus par nom de la base reconstruite ci-dessus).
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