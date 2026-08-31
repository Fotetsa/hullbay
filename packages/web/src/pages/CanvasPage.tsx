import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeChange,
  type Connection,
  type IsValidConnection,
  type FinalConnectionState,
} from "@xyflow/react"
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import { Navigate, useNavigate, useParams } from "react-router-dom"
import { Button, Heading, Text, toast, usePrompt } from "@medusajs/ui"
import { PlaySolid, Trash, ArrowLeft, ExclamationCircle, Spinner, XMark } from "@medusajs/icons"
import type { NodeType, ActualState, Node, Edge, DatabaseConfig, ProjectGraph } from "@hullbay/shared"
// Sous-chemin node-config : évite de tirer labels.ts (node:crypto) dans le bundle navigateur.
import { isConnectionAllowed, edgeKindForPair } from "@hullbay/shared/node-config"
import { api } from "../lib/api"
import { useMe } from "../lib/useMe"
import { useMutationToast } from "../lib/useMutationToast"
import { useOpsSocket, type NodePlacement } from "../lib/useOpsSocket"
import { OpsNode, type OpsNodeData } from "../canvas/OpsNode"
import { Palette } from "../canvas/Palette"
import { DbNetInfoPanel, type DbNetInfoData, type DbNetLinkRow } from "../canvas/DbNetPanel"
import { ENGINE_DEFAULTS } from "../canvas/forms/DatabaseForm"
import { Inspector } from "../canvas/Inspector"
import { EdgeInspector } from "../canvas/EdgeInspector"
import { DeployPlanModal } from "../canvas/DeployPlanModal"
import { nodeDeployState, gatewayState } from "../canvas/validate"
import { useTranslation } from "react-i18next"
import { ClusterNodesBar } from "../canvas/ClusterNodesBar"
import { colorForSwarmNode } from "../lib/clusterNodeColors"

/** Mappe la nature d'un lien persisté (edge.kind) sur l'id du handle correspondant. */
const KIND_TO_HANDLE: Record<string, string> = {
  network: "net-link",
  volume: "vol-link",
  gateway: "gw-link",
  database: "db-link",
}

const nodeTypes = { ops: OpsNode }

/** Style unique des liaisons « réseau DB » (hoisté : même référence à chaque render). */
const DASHED_DBNET_STYLE = { strokeDasharray: "6 4" }

/**
 * Id du nœud network créé avec une base (edge kind="network" vers un nœud
 * database), ou null. Factorisé pour la cascade de suppression (clavier +
 * Inspector) et la détection des réseaux non-supprimables.
 */
function dbNetworkFor(dbNode: Node, graph: ProjectGraph | null | undefined): { networkId: string } | null {
  if (!graph || dbNode.type !== "database") return null
  const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const link = graph.edges.find(
    (e) =>
      e.kind === "network" &&
      (e.sourceNodeId === dbNode.id || e.targetNodeId === dbNode.id)
  )
  if (!link) return null
  const networkId = typeById.get(link.sourceNodeId) === "network" ? link.sourceNodeId : link.targetNodeId
  return typeById.get(networkId) === "network" ? { networkId } : null
}

/** Vrai si ce nœud est un réseau lié à une base (non supprimable seul). */
function isLinkedDbNetwork(node: Node, graph: ProjectGraph | null | undefined): boolean {
  if (!graph || node.type !== "network") return false
  const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
  return graph.edges.some(
    (e) =>
      e.kind === "network" &&
      (e.sourceNodeId === node.id || e.targetNodeId === node.id) &&
      (typeById.get(e.sourceNodeId) === "database" || typeById.get(e.targetNodeId) === "database")
  )
}

/** Vrai si l'edge persisté est une liaison « réseau DB » (base↔conteneur OU
 *  base↔réseau) : purement visuelle, non interactive — le détail passe par le
 *  clic sur le nœud réseau de la base. */
function isDbNetEdge(edge: { id: string }, graph: ProjectGraph | null | undefined): boolean {
  if (!graph) return false
  const e = graph.edges.find((x) => x.id === edge.id)
  if (!e) return false
  if (e.kind === "database") return true
  if (e.kind !== "network") return false
  const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
  return (
    typeById.get(e.sourceNodeId) === "database" || typeById.get(e.targetNodeId) === "database"
  )
}

/** Id de la base liée à un nœud network (réseau de base), ou null si ce nœud
 *  n'est pas un réseau de base. Inverse de dbNetworkFor. */
function dbIdForNetwork(node: Node, graph: ProjectGraph | null | undefined): string | null {
  if (!graph || node.type !== "network") return null
  const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const link = graph.edges.find(
    (e) =>
      e.kind === "network" &&
      (e.sourceNodeId === node.id || e.targetNodeId === node.id) &&
      (typeById.get(e.sourceNodeId) === "database" ||
        typeById.get(e.targetNodeId) === "database")
  )
  if (!link) return null
  return typeById.get(link.sourceNodeId) === "database"
    ? link.sourceNodeId
    : link.targetNodeId
}

/** Config par défaut minimale pour chaque type créé par drop. */
const DEFAULT_CONFIG: Record<NodeType, Record<string, unknown>> = {
  container: {
    image: "nginx",
    tag: "latest",
    env: {},
    ports: [],
    restartPolicy: "unless-stopped",
    replicas: 1,
    updateParallelism: 1,
    updateDelaySec: 5,
  },
  network: { driver: "overlay", internal: false },
  volume: { driver: "local" },
  gateway: { domain: "example.com", targetPort: 80, tls: true },
  database: {
    engine: "postgres",
    version: "16.3",
    mode: "single",
    topology: { replicas: 1 },
    storage: { sizeGb: 20 },
    credentials: { username: "app", database: "app" },
    retainDataOnDelete: true,
  },
}

function CanvasInner({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const prompt = usePrompt()
  const { can } = useMe()
  const canDeploy = can("operator")
  const [backOpen, setBackOpen] = useState(false)
  
  const {
    data: graph,
    isLoading: graphLoading,
    isError: graphError,
  } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    placeholderData: keepPreviousData,
  })

    const { data: placement } = useQuery({
    queryKey: ["project-placement", projectId],
    queryFn: () => api.projectPlacement(projectId),
    refetchInterval: 15_000,
  })
  // Santé du cluster (nœuds Swarm + services) — SOURCE UNIQUE pour : le nom du
  // cluster affiché dans le header, la barre de nœuds (ClusterNodesBar) et la
  // couleur par nœud des piles de replicas (OpsNode). Une seule requête, trois
  // usages, pour que la même couleur soit garantie partout pour un même nœud.
  const { data: health } = useQuery({
    queryKey: ["health-cluster"],
    queryFn: api.clusterHealth,
    refetchInterval: 15_000,
  })
  const cluster = useMemo(
    () => health?.clusters.find((c) => c.clusterId === graph?.clusterId),
    [health, graph?.clusterId]
  )
  const orderedSwarmNodeIds = useMemo(() => cluster?.nodes.map((n) => n.swarmNodeId) ?? [], [cluster])

  // Récupération du nom lisible du cluster pour le header
  const { data: clusters } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.listClusters,
  })
  const clusterName = clusters?.find((c) => c.id === graph?.clusterId)?.name

  const [rfNodes, setRfNodes] = useState<RFNode[]>([])
  const [liveState, setLiveState] = useState<Record<string, ActualState>>({})
  const [liveReplicas, setLiveReplicas] = useState<Record<string, number>>({})
  // Détail par nœud Swarm de chaque replica RUNNING (event "node.placements") —
  // alimente la couleur des couches de la pile 3D dans OpsNode.tsx.
  const [livePlacements, setLivePlacements] = useState<Record<string, NodePlacement[]>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  // Liaison "réseau DB" sélectionnée (custom edge, panneau dédié lecture seule).
  // Nœud RÉSEAU de base sélectionné (panneau dédié des liaisons) — porté par le
  // nœud, pas par un edge : une base fraîche sans liaison doit quand même ouvrir
  // le panneau. Le network d'une base n'est pas éditable en soi.
  const [selectedDbNetNodeId, setSelectedDbNetNodeId] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [activityLog, setActivityLog] = useState<string[] | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition, getNode } = useReactFlow()

  const { volumeEdgesByContainer, embeddedVolumeNodeIds } = useMemo(() => {
    const byContainer = new Map<string, { id: string; name: string; mountPath?: string }[]>()
    const embedded = new Set<string>()
    if (!graph) return { volumeEdgesByContainer: byContainer, embeddedVolumeNodeIds: embedded }

    const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
    const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]))
    const volumeEdges = graph.edges
      .filter((e) => e.kind === "volume")
      .map((e) => ({
        containerId: typeById.get(e.sourceNodeId) === "container" ? e.sourceNodeId : e.targetNodeId,
        volId: typeById.get(e.sourceNodeId) === "volume" ? e.sourceNodeId : e.targetNodeId,
        mountPath: (e.config as { mountPath?: string } | null)?.mountPath?.trim() || undefined,
      }))

    const volumeEdgeCount = new Map<string, number>()
    for (const { volId } of volumeEdges) {
      volumeEdgeCount.set(volId, (volumeEdgeCount.get(volId) ?? 0) + 1)
    }
    for (const [volId, count] of volumeEdgeCount) {
      if (count === 1) embedded.add(volId)
    }
    for (const { containerId, volId, mountPath } of volumeEdges) {
      if (!embedded.has(volId)) continue
      const volName = nameById.get(volId)
      if (!volName) continue
      byContainer.set(containerId, [
        ...(byContainer.get(containerId) ?? []),
        { id: volId, name: volName, mountPath },
      ])
    }
    return { volumeEdgesByContainer: byContainer, embeddedVolumeNodeIds: embedded }
  }, [graph])

  const gatewayTargetByGateway = useMemo(() => {
    const map = new Map<string, string>()
    if (!graph) return map
    const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
    for (const e of graph.edges) {
      if (e.kind !== "gateway") continue
      const gwId = typeById.get(e.sourceNodeId) === "gateway" ? e.sourceNodeId : e.targetNodeId
      const targetId = typeById.get(e.sourceNodeId) === "gateway" ? e.targetNodeId : e.sourceNodeId
      if (typeById.get(gwId) === "gateway") map.set(gwId, targetId)
    }
    return map
  }, [graph])

  const networkedContainers = useMemo(() => {
    const set = new Set<string>()
    if (!graph) return set
    const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
    for (const e of graph.edges) {
      if (e.kind !== "network") continue
      const cId = typeById.get(e.sourceNodeId) === "container" ? e.sourceNodeId : e.targetNodeId
      if (typeById.get(cId) === "container") set.add(cId)
    }
    return set
  }, [graph])

  // Lien « réseau DB » : chaque edge persisté kind="database" (conteneur↔base)
  // est rendu comme un trait pointillé CONTENEUR → RÉSEAU DE LA BASE. Une base
  // naît avec son réseau (edge kind="network" base↔réseau, dessiné en pointillé
  // dans rfEdges) : visuellement, tout conteneur qui se connecte à la base passe
  // donc par SON réseau, jamais par la base directement. Base sans réseau
  // (projet antérieur) : fallback en ligne directe conteneur→base.
  const dbNetEdges: RFEdge[] = useMemo(() => {
    if (!graph) return []
    const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))

    return graph.edges.flatMap((e): RFEdge[] => {
      if (e.kind !== "database") return []
      const cId = typeById.get(e.sourceNodeId) === "container" ? e.sourceNodeId : e.targetNodeId
      const dbId = typeById.get(e.sourceNodeId) === "database" ? e.sourceNodeId : e.targetNodeId
      if (!cId || !dbId || cId === dbId) return []
      if (typeById.get(cId) !== "container" || typeById.get(dbId) !== "database") return []

      // Le conteneur se connecte au RÉSEAU de la base (celui créé au drop).
      const dbNode = graph.nodes.find((n) => n.id === dbId)!
      const linked = dbNetworkFor(dbNode, graph)
      const target = linked?.networkId ?? dbId
      const source = cId

      return [
        {
          id: e.id,
          source,
          target,
          sourceHandle: "db-link",
          targetHandle: target === dbId ? "db-link" : undefined,
          style: DASHED_DBNET_STYLE,
          selectable: false,
          deletable: false,
        },
      ]
    })
  }, [graph])

  // Données du panneau lecture seule : UNE base peut être reliée à PLUSIEURS
  // conteneurs — le panneau liste TOUTES les liaisons de la base cliquée (via
  // son RÉSEAU : le clic porte sur le nœud network, pas sur un edge — une base
  // fraîche sans liaison ouvre quand même le panneau), chacune supprimable
  // indépendamment. Résolu depuis le graphe persisté.
  const selectedDbNet: DbNetInfoData | null = useMemo(() => {
    if (!graph || !selectedDbNetNodeId) return null
    const typeById = new Map(graph.nodes.map((n) => [n.id, n.type]))
    const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]))
    const netNode = graph.nodes.find((n) => n.id === selectedDbNetNodeId && n.type === "network")
    if (!netNode) return null
    // Le réseau d'une base est lié à sa base par un edge kind="network".
    const dbLink = graph.edges.find(
      (e) =>
        e.kind === "network" &&
        (e.sourceNodeId === netNode.id || e.targetNodeId === netNode.id) &&
        (typeById.get(e.sourceNodeId) === "database" ||
          typeById.get(e.targetNodeId) === "database")
    )
    if (!dbLink) return null
    const dbNode =
      graph.nodes.find((n) => n.id === dbLink.sourceNodeId && n.type === "database") ??
      graph.nodes.find((n) => n.id === dbLink.targetNodeId && n.type === "database")
    if (!dbNode) return null
    const links: DbNetLinkRow[] = []
    for (const e of graph.edges) {
      if (e.kind !== "database") continue
      const cId =
        typeById.get(e.sourceNodeId) === "container"
          ? e.sourceNodeId
          : typeById.get(e.targetNodeId) === "container"
            ? e.targetNodeId
            : null
      const dId =
        typeById.get(e.sourceNodeId) === "database"
          ? e.sourceNodeId
          : typeById.get(e.targetNodeId) === "database"
            ? e.targetNodeId
            : null
      if (!cId || dId !== dbNode.id) continue
      links.push({ edgeId: e.id, containerName: nameById.get(cId) ?? cId })
    }
    const cfg = dbNode.config as DatabaseConfig | null
    return {
      dbName: dbNode.name,
      overlayName: `boz_${graph.slug}_${dbNode.name}-net`,
      engine: cfg?.engine ?? "postgres",
      mode: cfg?.mode ?? "single",
      links,
    }
  }, [graph, selectedDbNetNodeId])

  const onContainerVolumeDrop = useCallback(
    async (containerNodeId: string) => {
      try {
        const created = await api.createNode(projectId, {
          type: "volume",
          name: `volume-${Math.random().toString(36).slice(2, 6)}`,
          posX: 0,
          posY: 0,
          config: DEFAULT_CONFIG.volume,
        })
        await api.createEdge(projectId, {
          sourceNodeId: containerNodeId,
          targetNodeId: created.id,
          kind: "volume",
        })
        qc.invalidateQueries({ queryKey: ["project", projectId] })
      } catch (err) {
        toast.error("Erreur", { description: (err as Error).message })
      }
    },
    [projectId, qc]
  )

  useEffect(() => {
    if (!graph) return
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const stateById = new Map<string, ActualState | null | undefined>(
        graph.nodes.map((n) => {
          const ex = prevById.get(n.id)
          return [n.id, ex ? (ex.data as OpsNodeData).actualState : (liveState[n.id] ?? n.actualState ?? null)]
        })
      )
      return graph.nodes
        .filter((n) => !embeddedVolumeNodeIds.has(n.id))
        .map((n) => {
          const existing = prevById.get(n.id)
          const isGw = n.type === "gateway"
          const gwCfg = isGw ? (n.config as { domain?: string; targetPort?: number } | null) : null
          const targetId = isGw ? gatewayTargetByGateway.get(n.id) : undefined
          const dbCfg = n.type === "database" ? (n.config as DatabaseConfig | null) : null
          const dbSummary = dbCfg
            ? {
                engine: dbCfg.engine ?? "postgres",
                mode: dbCfg.mode ?? "single",
                replicas:
                  dbCfg.topology?.replicas ??
                  (dbCfg.mode === "ha"
                    ? ENGINE_DEFAULTS[dbCfg.engine ?? "postgres"].haReplicas[0]!
                    : 1),
                consensus: dbCfg.topology?.consensusReplicas,
              }
            : undefined
          const liveDriven = n.type === "container"
          const resolvedState = liveDriven
            ? existing
              ? (existing.data as OpsNodeData).actualState
              : (liveState[n.id] ?? n.actualState ?? null)
            : (n.actualState ?? null)
          return {
            id: n.id,
            type: "ops",
            position: { x: n.posX, y: n.posY },
            data: {
              label: n.name,
              nodeType: n.type,
              actualState: resolvedState,
              // Réseau d'une base : handle vert + connexion = relation database.
              ...(n.type === "network"
                ? { isDbLinkedNetwork: isLinkedDbNetwork(n, graph) }
                : {}),
              desiredReplicas: (n.config as { replicas?: number } | null)?.replicas ?? 1,
                            runningReplicas: existing
                ? (existing.data as OpsNodeData).runningReplicas
                : liveReplicas[n.id],
              // Détail par nœud Swarm (pile 3D colorée) : même logique "garder le
              // live existant, sinon repartir de ce qu'on a déjà reçu" que
              // runningReplicas ci-dessus. clusterNodeOrder vient de la requête
              // clusterHealth levée plus haut dans CanvasInner (même valeur pour
              // tous les nœuds, cf. ClusterNodesBar pour la même source).
              placements: existing
                ? (existing.data as OpsNodeData).placements
                : livePlacements[n.id],
              clusterNodeOrder: orderedSwarmNodeIds,
              attachedVolumes: n.type === "container" ? volumeEdgesByContainer.get(n.id) : undefined,
              ...(n.type === "container"
                ? {
                    publishedPorts: (
                      (n.config as { ports?: { host?: number; container: number }[] } | null)?.ports ?? []
                    )
                      .filter((p): p is { host: number; container: number } => typeof p.host === "number")
                      .map((p) => ({ host: p.host, container: p.container })),
                    onNetwork: networkedContainers.has(n.id),
                  }
                : {}),
              deployState: nodeDeployState(n, graph.status),
              ...(isGw
                ? {
                    gatewayState: gatewayState(
                      nodeDeployState(n, graph.status) === "deployed",
                      targetId ? stateById.get(targetId) ?? null : null
                    ),
                    gatewayDomain: gwCfg?.domain,
                    gatewayTargetPort: gwCfg?.targetPort,
                  }
                : {}),
              onVolumeDrop:
                n.type === "container" ? () => onContainerVolumeDrop(n.id) : undefined,
              onVolumeClick: n.type === "container" ? (id: string) => setSelectedId(id) : undefined,
              ...(n.type === "database" && dbSummary ? { dbSummary } : {}),
            } satisfies OpsNodeData,
          }
        })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, embeddedVolumeNodeIds, volumeEdgesByContainer, onContainerVolumeDrop, gatewayTargetByGateway, networkedContainers])

  useEffect(() => {
    setRfNodes((prev) => {
      const next = prev.map((n) => {
        const state = liveState[n.id]
        if (state === undefined || (n.data as OpsNodeData).actualState === state) return n
        return { ...n, data: { ...(n.data as OpsNodeData), actualState: state } }
      })
      const stateById = new Map(next.map((n) => [n.id, (n.data as OpsNodeData).actualState]))
      return next.map((n) => {
        const d = n.data as OpsNodeData
        if (d.nodeType !== "gateway") return n
        const targetId = gatewayTargetByGateway.get(n.id)
        const computed = gatewayState(
          d.deployState === "deployed",
          targetId ? stateById.get(targetId) ?? null : null
        )
        if (computed === d.gatewayState) return n
        return { ...n, data: { ...d, gatewayState: computed } }
      })
    })
  }, [liveState, gatewayTargetByGateway])

    useEffect(() => {
    setRfNodes((prev) =>
      prev.map((n) => {
        const replicas = liveReplicas[n.id]
        if (replicas === undefined || (n.data as OpsNodeData).runningReplicas === replicas) {
          return n
        }
        return { ...n, data: { ...(n.data as OpsNodeData), runningReplicas: replicas } }
      })
    )
  }, [liveReplicas])

  // Idem pour le détail par nœud Swarm (pile 3D colorée) + l'ordre des nœuds du
  // cluster (recalculé quand `health` change, ex: nœud ajouté/retiré du Swarm) —
  // deux sources différentes mais le même nœud React Flow à mettre à jour.
  useEffect(() => {
    setRfNodes((prev) =>
      prev.map((n) => {
        const placements = livePlacements[n.id]
        const d = n.data as OpsNodeData
        const placementsChanged = placements !== undefined && placements !== d.placements
        const orderChanged = orderedSwarmNodeIds !== d.clusterNodeOrder
        if (!placementsChanged && !orderChanged) return n
        return {
          ...n,
          data: {
            ...d,
            placements: placements ?? d.placements,
            clusterNodeOrder: orderedSwarmNodeIds,
          },
        }
      })
    )
  }, [livePlacements, orderedSwarmNodeIds])

  const rfEdges: RFEdge[] = useMemo(
    () => {
      // Oriente correctement les edges "network" impliquant une base : la base
      // n'expose QUE le handle cible "db-link" (et le network le source
      // "db-link") — le mapping générique "net-link"/"net-link" rendrait un
      // edge base↔réseau invisible (handle source introuvable côté base).
      const typeById = new Map(graph?.nodes.map((n) => [n.id, n.type]))
      return (graph?.edges ?? [])
        .filter(
          (e) =>
            !embeddedVolumeNodeIds.has(e.sourceNodeId) &&
            !embeddedVolumeNodeIds.has(e.targetNodeId) &&
            e.kind !== "database"
        )
        .map((e) => {
          // Paire base↔réseau (auto-créée au drop) : la base n'expose QUE le
          // handle cible "db-link", le réseau le source "db-link" — on oriente
          // toujours le rendu réseau → base avec ce handle, quelle que soit la
          // direction persistée. Le mapping générique "net-link"/"net-link"
          // rendrait la ligne invisible (handle source introuvable côté base).
          if (e.kind === "network") {
            const sIsDb = typeById.get(e.sourceNodeId) === "database"
            const sIsNet = typeById.get(e.sourceNodeId) === "network"
            const tIsDb = typeById.get(e.targetNodeId) === "database"
            const tIsNet = typeById.get(e.targetNodeId) === "network"
            if ((sIsDb && tIsNet) || (sIsNet && tIsDb)) {
              const netId = sIsNet ? e.sourceNodeId : e.targetNodeId
              const dbId = sIsDb ? e.sourceNodeId : e.targetNodeId
              // Pointillé : matérialise la dépendance d'une base à SON réseau
              // (le réseau est né avec la base, pas une liaison utilisateur).
              // Non sélectionnable : le détail passe par le nœud réseau.
              return {
                id: e.id,
                source: netId,
                target: dbId,
                sourceHandle: "db-link",
                targetHandle: "db-link",
                style: DASHED_DBNET_STYLE,
                selectable: false,
                deletable: false,
                selected: e.id === selectedEdgeId,
              }
            }
          }
          return {
            id: e.id,
            source: e.sourceNodeId,
            target: e.targetNodeId,
            sourceHandle: KIND_TO_HANDLE[e.kind] ?? undefined,
            targetHandle: KIND_TO_HANDLE[e.kind] ?? undefined,
            selected: e.id === selectedEdgeId,
          }
        })
    },
    [graph, selectedEdgeId, embeddedVolumeNodeIds]
  )

  const selectedNode: Node | null = useMemo(
    () => graph?.nodes.find((n) => n.id === selectedId) ?? null,
    [graph, selectedId]
  )

  const selectedEdge: Edge | null = useMemo(
    () => graph?.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [graph, selectedEdgeId]
  )

  const onNodeState = useCallback((p: { nodeId: string; state: string }) => {
    setLiveState((prev) => ({ ...prev, [p.nodeId]: p.state as ActualState }))
  }, [])
  const onNodeReplicas = useCallback((p: { nodeId: string; runningReplicas: number }) => {
    setLiveReplicas((prev) => ({ ...prev, [p.nodeId]: p.runningReplicas }))
  }, [])
  const onNodePlacements = useCallback((p: { nodeId: string; placements: NodePlacement[] }) => {
    setLivePlacements((prev) => ({ ...prev, [p.nodeId]: p.placements }))
  }, [])
  const { connected } = useOpsSocket(projectId, onNodeState, onNodeReplicas, onNodePlacements)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds))
    for (const c of changes) {
      if (c.type === "position" && c.dragging === false && c.position) {
        api.updateNode(c.id, { posX: c.position.x, posY: c.position.y }).catch(() => {})
      }
    }
  }, [])

  const onConnect = useCallback(
    async (conn: Connection) => {
      if (!conn.source || !conn.target) return
      const sType = (getNode(conn.source)?.data as OpsNodeData | undefined)?.nodeType
      const tType = (getNode(conn.target)?.data as OpsNodeData | undefined)?.nodeType
      let kind = sType && tType ? edgeKindForPair(sType, tType) : null
      if (!kind) return

      // Connexion conteneur ↔ RÉSEAU de base (handle vert) : on relie en réalité
      // le conteneur à la BASE (relation database), pas au réseau lui-même — le
      // réseau n'est qu'un point d'ancrage visuel, sa vie est liée à la base.
      let sourceId = conn.source
      let targetId = conn.target
      if (graph) {
        const sNode = graph.nodes.find((n) => n.id === conn.source)
        const tNode = graph.nodes.find((n) => n.id === conn.target)
        if (sNode && isLinkedDbNetwork(sNode, graph)) {
          const dbId = dbIdForNetwork(sNode, graph)
          if (dbId) {
            sourceId = dbId
            kind = "database"
          }
        }
        if (tNode && isLinkedDbNetwork(tNode, graph)) {
          const dbId = dbIdForNetwork(tNode, graph)
          if (dbId) {
            targetId = dbId
            kind = "database"
          }
        }
      }

      // Dédup front : un couple de nœuds ne porte qu'UN lien par nature (sens
      // indifférent). Sans ça, re-tirer un lien database existant créait un
      // doublon invisible — le visuel ne changeait pas et l'entrée se polluait.
      const exists = graph?.edges.some(
        (e) =>
          e.kind === kind &&
          ((e.sourceNodeId === sourceId && e.targetNodeId === targetId) ||
            (e.sourceNodeId === targetId && e.targetNodeId === sourceId))
      )
      if (exists) {
        toast.error("Déjà relié", { description: "Ces deux nœuds sont déjà reliés par ce type de lien." })
        return
      }
      try {
        await api.createEdge(projectId, { sourceNodeId: sourceId, targetNodeId: targetId, kind })
        qc.invalidateQueries({ queryKey: ["project", projectId] })
        if (kind === "database") {
          const dbId = sourceId === targetId ? sourceId : graph?.nodes.find((n) => n.id === targetId)?.type === "database" ? targetId : sourceId
          const dbName = graph?.nodes.find((n) => n.id === dbId)?.name
          toast.success("Liaison créée", {
            description: `Base « ${dbName ?? "?"} » reliée. Le réseau ${dbName ?? "db"}-net sera créé au déploiement.`,
          })
        }
      } catch (err) {
        toast.error("Connexion refusée", { description: (err as Error).message })
      }
    },
    [projectId, qc, getNode, graph]
  )

  const isValidConnection = useCallback<IsValidConnection>(
    (conn) => {
      const c = conn as Connection
      if (!c.source || !c.target || c.source === c.target) return false
      const sType = (getNode(c.source)?.data as OpsNodeData | undefined)?.nodeType
      const tType = (getNode(c.target)?.data as OpsNodeData | undefined)?.nodeType
      if (!sType || !tType || !isConnectionAllowed(sType, tType)) return false
      if (c.sourceHandle && c.targetHandle && c.sourceHandle !== c.targetHandle) return false
      // Réseau d'une base : connectable UNIQUEMENT depuis/vers un conteneur
      // (cela crée la relation database avec la base liée — handle vert).
      // Tout autre couple (réseau↔réseau de base, volume↔réseau de base, …)
      // est refusé : le réseau de base n'est pas un réseau normal.
      const srcNode = graph?.nodes.find((n) => n.id === c.source)
      const tgtNode = graph?.nodes.find((n) => n.id === c.target)
      if (srcNode && isLinkedDbNetwork(srcNode, graph) && tType !== "container") return false
      if (tgtNode && isLinkedDbNetwork(tgtNode, graph) && sType !== "container") return false
      return true
    },
    [getNode, graph]
  )

  const onConnectEnd = useCallback(
    (_e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid === false && state.fromNode && state.toNode) {
        const fromType = (state.fromNode.data as OpsNodeData | undefined)?.nodeType
        const toType = (state.toNode.data as OpsNodeData | undefined)?.nodeType
        toast.error("Connexion impossible", {
          description: `${fromType ?? "?"} ne peut pas se relier directement à ${toType ?? "?"}.`,
        })
      }
    },
    []
  )

  const createNodeAt = useCallback(
    async (type: NodeType, pos: { x: number; y: number }) => {
      try {
        const created = await api.createNode(projectId, {
          type,
          name: `${type}-${Math.random().toString(36).slice(2, 6)}`,
          posX: pos.x,
          posY: pos.y,
          config: DEFAULT_CONFIG[type],
        })
        // Une base vient logiquement AVEC son réseau : on crée un nœud network
        // (composant canvas standard) juste à côté, relié par un edge
        // kind="network". Tout conteneur se connectant ensuite à la base passera
        // visuellement par CE réseau, pas par la base directement.
        if (type === "database") {
          const net = await api.createNode(projectId, {
            type: "network",
            name: `${created.name}-net`,
            posX: pos.x + 200,
            posY: pos.y,
            config: DEFAULT_CONFIG["network"],
          })
          await api.createEdge(projectId, {
            sourceNodeId: created.id,
            targetNodeId: net.id,
            kind: "network",
          })
        }
        qc.invalidateQueries({ queryKey: ["project", projectId] })
      } catch (err) {
        toast.error("Erreur", { description: (err as Error).message })
      }
    },
    [projectId, qc]
  )

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      const type = e.dataTransfer.getData("application/bozando-node-type") as NodeType
      if (!type) return
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      createNodeAt(type, pos)
    },
    [screenToFlowPosition, createNodeAt]
  )

  const onAddNode = useCallback(
    (type: NodeType) => {
      const rect = wrapperRef.current?.getBoundingClientRect()
      const center = rect
        ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        : { x: 200, y: 150 }
      createNodeAt(type, center)
    },
    [screenToFlowPosition, createNodeAt]
  )

  const deployMut = useMutationToast({
    mutationFn: () => api.deploy(projectId),
    success: "Déployé",
    successDescription: (r) => `${r.log.length} opérations`,
    invalidate: [["project", projectId]],
    errorTitle: "Déploiement échoué",
    errorDuration: 30000,
    onSuccess: (r) => {
      setPlanOpen(false)
      setActivityLog(r.log)
      setActivityOpen(true)
    },
  })

  const destroyMut = useMutationToast({
    mutationFn: () => api.destroy(projectId),
    success: "Détruit",
    invalidate: [["project", projectId]],
    errorDuration: 10000,
    onSuccess: (r) => {
      setActivityLog(r.log)
      setActivityOpen(true)
    },
  })

  const onDestroy = useCallback(async () => {
    const services = graph?.nodes.filter((n) => n.type === "container" && n.dockerId).length ?? 0
    const ok = await prompt({
      title: "Détruire les ressources déployées ?",
      description:
        `Toutes les ressources Docker gérées de ce projet seront supprimées` +
        (services ? ` (${services} service(s) en cours).` : ".") +
        ` Le graphe (désiré) est conservé : tu pourras redéployer.`,
      confirmText: "Détruire",
      cancelText: "Annuler",
      variant: "danger",
    })
    if (ok) destroyMut.mutate()
  }, [graph, prompt, destroyMut])

  const onKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return
      const target = e.target as HTMLElement
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return
      if (selectedEdgeId) {
        const ok = await prompt({
          title: "Supprimer ce lien ?",
          description: "Redéploie pour appliquer le changement à Docker.",
          confirmText: "Supprimer",
          cancelText: "Annuler",
          variant: "danger",
        })
        if (ok) {
          await api.deleteEdge(selectedEdgeId).catch(() => {})
          setSelectedEdgeId(null)
          qc.invalidateQueries({ queryKey: ["project", projectId] })
        }
      } else if (selectedId) {
        const node = graph?.nodes.find((n) => n.id === selectedId)
        // Un réseau lié à une base ne peut pas être supprimé seul : sa vie est
        // liée à celle de la base (créé avec elle, supprimé avec elle).
        if (node && isLinkedDbNetwork(node, graph)) {
          toast.error("Suppression refusée", {
            description: "Ce réseau accompagne une base de données. Supprimez la base pour le retirer.",
          })
          return
        }
        const ok = await prompt({
          title: "Supprimer ce nœud ?",
          description: `« ${node?.name ?? selectedId} » sera retiré du projet. Redéploie pour appliquer à Docker.`,
          confirmText: "Supprimer",
          cancelText: "Annuler",
          variant: "danger",
        })
        if (ok) {
          try {
            await api.deleteNode(selectedId)
            // Une base emporte son réseau avec elle (créés ensemble au drop).
            const linked = node ? dbNetworkFor(node, graph) : null
            if (linked) await api.deleteNode(linked.networkId).catch(() => {})
            toast.success("Supprimé", { description: `« ${node?.name ?? selectedId} » retiré du projet.` })
          } catch (err) {
            toast.error("Suppression impossible", { description: (err as Error).message })
          }
          setSelectedId(null)
          qc.invalidateQueries({ queryKey: ["project", projectId] })
        }
      }
    },
    [selectedEdgeId, selectedDbNetNodeId, selectedId, graph, prompt, qc, projectId]
  )

  if (graphError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-ui-bg-subtle">
        <ExclamationCircle className="text-ui-fg-error" />
        <Text className="text-ui-fg-subtle">Impossible de charger ce projet.</Text>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Retour aux projets
        </Button>
      </div>
    )
  }

  if (graphLoading && !graph) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Spinner className="animate-spin text-ui-fg-muted" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header en 3 zones (grid) : Live à gauche, nom du projet + cluster
          CENTRÉS au milieu, actions de déploiement à droite — plus de fil
          d'Ariane ni de badge de statut projet, juste le strict nécessaire
          pour "respirer". */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-ui-border-base bg-ui-bg-base px-6 py-5">
        <div className="flex items-center gap-2">
          <Button variant="transparent" size="small" onClick={() => setBackOpen(true)} title={t('projects.pageTitle')}>
            <ArrowDownLeft />
          </Button>
          <StatusBadge color={connected ? "green" : "orange"}>
            {connected ? "Live" : "Reconnexion…"}
          </StatusBadge>
        </div>

        {backOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setBackOpen(false)} />
            <div className="relative z-10 w-full max-w-md rounded-lg bg-ui-bg-base p-6 shadow-elevation-flyout ring-1 ring-ui-border-base">
              <div className="flex items-start justify-between">
                <Heading level="h3">Retour aux projets</Heading>
                <button
                  type="button"
                  aria-label="Fermer"
                  className="text-ui-fg-subtle hover:text-ui-fg-base"
                  onClick={() => setBackOpen(false)}
                >
                  <XMark />
                </button>
              </div>
              <Text className="mt-3 text-ui-fg-subtle">Retourner à la liste des projets ? Les modifications non sauvegardées seront perdues.</Text>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setBackOpen(false)}>{t('projects.actions.cancel')}</Button>
                <Button onClick={() => { setBackOpen(false); navigate('/'); }}>{t('projects.pageTitle')}</Button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col items-center text-center">
          <Heading level="h2">{graph?.name ?? "…"}</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Cluster : {cluster?.clusterName ?? "…"}
            {placement && placement.servers.length > 0 && (
              <> · {placement.servers.join(", ")}</>
            )}
          </Text>
        </div>

        <div className="flex items-center justify-end gap-2">
          {activityLog && (
            <Button variant="transparent" size="small" onClick={() => setActivityOpen((v) => !v)}>
              Activité
            </Button>
          )}
          {canDeploy ? (
            <>
              <Button
                onClick={() => {
                  setSelectedId(null)
                  setSelectedEdgeId(null)
                  setPlanOpen(true)
                }}
                isLoading={deployMut.isPending}
              >
                <PlaySolid /> Déployer
              </Button>
              <Button variant="danger" onClick={onDestroy} isLoading={destroyMut.isPending}>
                <Trash /> Détruire
              </Button>
            </>
          ) : (
            <span title="Rôle operator requis pour déployer">
              <Button disabled>
                <PlaySolid /> Déployer
              </Button>
            </span>
          )}
        </div>
      </div>

      {/* Canvas plein écran */}
      <div className="flex flex-1 overflow-hidden">
        <div
          className="relative flex-1 outline-none"
          ref={wrapperRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
          }}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={[...rfEdges, ...dbNetEdges]}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onConnectEnd={onConnectEnd}
            onNodeClick={(_e, n) => {
              // Clic sur le RÉSEAU d'une base (edge kind="network" vers un nœud
              // database) : on ouvre le panneau dédié des liaisons, PAS
              // l'Inspector network générique. Le network d'une base n'est pas
              // éditable en soi — sa vraie config vit sur la base.
              const nodeType = (n.data as OpsNodeData | undefined)?.nodeType
              if (nodeType === "network" && graph) {
                const typeById = new Map(graph.nodes.map((x) => [x.id, x.type]))
                const dbLink = graph.edges.find(
                  (e) =>
                    e.kind === "network" &&
                    (e.sourceNodeId === n.id || e.targetNodeId === n.id) &&
                    (typeById.get(e.sourceNodeId) === "database" ||
                      typeById.get(e.targetNodeId) === "database")
                )
                if (dbLink) {
                  setSelectedDbNetNodeId(n.id)
                  setSelectedId(null)
                  setSelectedEdgeId(null)
                  return
                }
              }
              setSelectedId(n.id)
              setSelectedEdgeId(null)
              setSelectedDbNetNodeId(null)
            }}
            onEdgeClick={(_e, edge) => {
              // Les pointillés réseau DB (conteneur→réseau, base↔réseau) sont
              // non interactifs : le panneau de détail s'ouvre UNIQUEMENT au
              // clic sur le nœud réseau de la base (toutes ses liaisons).
              if (
                graph?.edges.find((x) => x.id === edge.id)?.kind === "database" ||
                isDbNetEdge(edge, graph)
              ) {
                return
              }
              setSelectedEdgeId(edge.id)
              setSelectedId(null)
              setSelectedDbNetNodeId(null)
            }}
            onPaneClick={() => {
              setSelectedId(null)
              setSelectedEdgeId(null)
              setSelectedDbNetNodeId(null)
            }}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>

          {/* Palette flottante (overlay gauche) + barre des nœuds Swarm (bas-gauche,
              à côté des Controls React Flow). */}
          <Palette onAdd={onAddNode} />
          <ClusterNodesBar cluster={cluster} />

          {graph && graph.nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="rounded-xl border border-dashed border-ui-border-strong bg-ui-bg-base/80 px-6 py-4 text-center backdrop-blur">
                <Text weight="plus">Projet vide</Text>
                <Text size="small" className="text-ui-fg-subtle">
                  Glisse un composant depuis la palette, ou clique dessus pour l'ajouter.
                </Text>
              </div>
            </div>
          )}

          {activityOpen && activityLog && (
            <div
              className="absolute bottom-4 right-4 z-10 w-[min(420px,calc(100%-2rem))] overflow-hidden rounded-xl border border-ui-border-base bg-ui-bg-base shadow-elevation-flyout"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center justify-between border-b border-ui-border-base px-3 py-2">
                <Text size="small" weight="plus" className="text-ui-fg-base">
                  Activité de déploiement
                </Text>
                <button
                  type="button"
                  className="text-ui-fg-muted transition-colors hover:text-ui-fg-base"
                  aria-label="Fermer le panneau d'activité"
                  onClick={() => setActivityOpen(false)}
                >
                  <XMark />
                </button>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-ui-fg-subtle txt-compact-xsmall">
                {activityLog.length ? activityLog.join("\n") : "Aucune opération."}
              </pre>
            </div>
          )}

          {selectedNode && (
            <Inspector
              key={selectedNode.id}
              node={selectedNode}
              projectId={projectId}
              clusterId={graph?.clusterId ?? null}
              linkedNetworkId={dbNetworkFor(selectedNode, graph)?.networkId ?? null}
              isLinkedDbNetwork={isLinkedDbNetwork(selectedNode, graph)}
              onClose={() => setSelectedId(null)}
              onSaved={() => qc.invalidateQueries({ queryKey: ["project", projectId] })}
              onDeleted={() => {
                setSelectedId(null)
                qc.invalidateQueries({ queryKey: ["project", projectId] })
              }}
            />
          )}

          {selectedDbNet && (
            <DbNetInfoPanel
              data={selectedDbNet}
              onClose={() => setSelectedDbNetNodeId(null)}
              onDeleteLink={async (edgeId) => {
                await api.deleteEdge(edgeId).catch(() => {})
                const remaining = selectedDbNet.links.filter((l) => l.edgeId !== edgeId)
                if (remaining.length === 0) setSelectedDbNetNodeId(null)
                qc.invalidateQueries({ queryKey: ["project", projectId] })
              }}
            />
          )}

          {selectedEdge && (
            <EdgeInspector
              key={selectedEdge.id}
              edge={selectedEdge}
              onClose={() => setSelectedEdgeId(null)}
              onSaved={() => qc.invalidateQueries({ queryKey: ["project", projectId] })}
              onDeleted={() => {
                setSelectedEdgeId(null)
                qc.invalidateQueries({ queryKey: ["project", projectId] })
              }}
            />
          )}
        </div>
      </div>

      {graph && (
        <DeployPlanModal
          open={planOpen}
          onOpenChange={setPlanOpen}
          graph={graph}
          isDeploying={deployMut.isPending}
          onConfirm={() => deployMut.mutate()}
        />
      )}
    </div>
  )
}

export function CanvasPage() {
  const { projectId } = useParams<{ projectId: string }>()
  if (!projectId) return <Navigate to="/" replace />
  return (
    <ReactFlowProvider>
      <CanvasInner projectId={projectId} />
    </ReactFlowProvider>
  )
}