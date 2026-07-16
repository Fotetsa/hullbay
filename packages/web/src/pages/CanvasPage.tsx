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
import type { NodeType, ActualState, Node, Edge } from "@bozando-ops/shared"
// Sous-chemin node-config : évite de tirer labels.ts (node:crypto) dans le bundle navigateur.
import { isConnectionAllowed, edgeKindForPair } from "@bozando-ops/shared/node-config"
import { api } from "../lib/api"
import { useMe } from "../lib/useMe"
import { useMutationToast } from "../lib/useMutationToast"
import { useOpsSocket } from "../lib/useOpsSocket"
import { OpsNode, type OpsNodeData } from "../canvas/OpsNode"
import { Palette } from "../canvas/Palette"
import { Inspector } from "../canvas/Inspector"
import { EdgeInspector } from "../canvas/EdgeInspector"
import { DeployPlanModal } from "../canvas/DeployPlanModal"
import { nodeDeployState, gatewayState } from "../canvas/validate"

/** Mappe la nature d'un lien persisté (edge.kind) sur l'id du handle correspondant. */
const KIND_TO_HANDLE: Record<string, string> = {
  network: "net-link",
  volume: "vol-link",
  gateway: "gw-link",
}

const nodeTypes = { ops: OpsNode }

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
}

function CanvasInner({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const prompt = usePrompt()
  const { can } = useMe()
  const canDeploy = can("operator")
  // `placeholderData: keepPreviousData` : pendant un refetch (invalidateQueries
  // après deploy/destroy/edit), garde l'ancien graphe affiché au lieu de repasser
  // par `undefined` — sans ça, `rfEdges` (dérivé direct de `graph?.edges ?? []`,
  // pas un state comme `rfNodes`) retombait à `[]` pendant la fenêtre de refetch,
  // et tout le canvas (nœuds + liens) pouvait clignoter/disparaître visuellement
  // entre deux cycles destroy/deploy — c'était la cause de l'instabilité observée.
  const {
    data: graph,
    isLoading: graphLoading,
    isError: graphError,
  } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject(projectId),
    placeholderData: keepPreviousData,
  })
  // Sur quel(s) serveur(s) ce projet tourne réellement (placement Swarm).
  const { data: placement } = useQuery({
    queryKey: ["project-placement", projectId],
    queryFn: () => api.projectPlacement(projectId),
    refetchInterval: 15_000,
  })

  const [rfNodes, setRfNodes] = useState<RFNode[]>([])
  const [liveState, setLiveState] = useState<Record<string, ActualState>>({})
  const [liveReplicas, setLiveReplicas] = useState<Record<string, number>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  // Journal de la dernière opération (deploy/destroy) — affiché dans un panneau
  // déroulant `aria-live` au lieu d'un toast tronqué.
  const [activityLog, setActivityLog] = useState<string[] | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const { screenToFlowPosition, getNode } = useReactFlow()

  // Volumes "emboîtés" : un volume relié à EXACTEMENT un conteneur (cas du drop
  // direct sur le nœud) est affiché en badge sur ce conteneur plutôt qu'en nœud
  // libre + ligne visible — purement visuel, le modèle Node/Edge(kind="volume")
  // ne change pas (un volume relié à plusieurs conteneurs, ou créé par drop libre
  // sur le canvas, reste affiché comme nœud séparé classique).
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

  // Passerelle -> conteneur cible : map gatewayNodeId -> containerNodeId, à partir
  // de l'edge kind="gateway". Sert à dériver l'état "en ligne / cible hors-ligne"
  // de la route depuis la santé live du conteneur upstream (cf. validate.gatewayState).
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

  // Conteneurs reliés à au moins un réseau (edge kind="network") : sert à l'indicateur
  // d'accès du nœud (un conteneur sans réseau ni port publié est isolé).
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

  // Drop d'un volume DIRECTEMENT sur un conteneur (pas sur le canvas vide) :
  // crée le couple Node(volume)+Edge(kind="volume") en une seule action utilisateur.
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

  // Reconstruction COMPLÈTE seulement quand le graphe lui-même change (nœud
  // ajouté/déplacé/supprimé) — PAS à chaque event "node.state". Recréer tout le
  // tableau `rfNodes` à chaque event temps réel (un par conteneur en rafale
  // pendant un deploy/destroy) faisait perdre à React Flow le lien entre les
  // edges et leurs Handle internes (ré-enregistrement async des Handle sur
  // changement de référence de `nodes`), d'où les liens qui disparaissaient
  // visuellement pile au moment où l'état passait au vert.
  useEffect(() => {
    if (!graph) return
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      // État actuel (live si connu) de chaque nœud, pour résoudre la cible des passerelles.
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
          // Conteneur : on garde l'état caché/live (l'observer le pousse en continu,
          // éviter le flicker pendant un rolling update). Réseau/volume/passerelle
          // n'émettent AUCUN event live -> on fait confiance à l'actualState fraîchement
          // refetch du graphe (sinon leur voyant resterait gris : bug observé).
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
              desiredReplicas: (n.config as { replicas?: number } | null)?.replicas ?? 1,
              runningReplicas: existing
                ? (existing.data as OpsNodeData).runningReplicas
                : liveReplicas[n.id],
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
            } satisfies OpsNodeData,
          }
        })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, embeddedVolumeNodeIds, volumeEdgesByContainer, onContainerVolumeDrop, gatewayTargetByGateway, networkedContainers])

  // Mise à jour INCRÉMENTALE : un event "node.state"/"node.replicas" ne touche
  // QUE le nœud concerné, en mutant son `data` en place plutôt qu'en recréant
  // tout le tableau (cf. commentaire ci-dessus — même piège React Flow/Handle).
  useEffect(() => {
    setRfNodes((prev) => {
      // 1) Met à jour l'état propre de chaque nœud conteneur dont l'event est arrivé.
      const next = prev.map((n) => {
        const state = liveState[n.id]
        if (state === undefined || (n.data as OpsNodeData).actualState === state) return n
        return { ...n, data: { ...(n.data as OpsNodeData), actualState: state } }
      })
      // 2) Recalcule l'état des passerelles : il dépend de la santé du conteneur
      // CIBLE, pas de la passerelle elle-même (qui n'émet aucun event live).
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

  const rfEdges: RFEdge[] = useMemo(
    () =>
      (graph?.edges ?? [])
        .filter(
          (e) =>
            !embeddedVolumeNodeIds.has(e.sourceNodeId) &&
            !embeddedVolumeNodeIds.has(e.targetNodeId)
        )
        .map((e) => ({
          id: e.id,
          source: e.sourceNodeId,
          target: e.targetNodeId,
          sourceHandle: KIND_TO_HANDLE[e.kind] ?? undefined,
          targetHandle: KIND_TO_HANDLE[e.kind] ?? undefined,
          selected: e.id === selectedEdgeId,
        })),
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
  const { connected } = useOpsSocket(projectId, onNodeState, onNodeReplicas)

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
      const kind = sType && tType ? edgeKindForPair(sType, tType) : null
      if (!kind) return
      try {
        await api.createEdge(projectId, { sourceNodeId: conn.source, targetNodeId: conn.target, kind })
        qc.invalidateQueries({ queryKey: ["project", projectId] })
      } catch (err) {
        toast.error("Connexion refusée", { description: (err as Error).message })
      }
    },
    [projectId, qc, getNode]
  )

  // GNS3-like : bloque au moment du drag les paires de nœuds qui n'ont pas de sens
  // (ex: volume <-> gateway), via la même matrice que le back (zéro dérive).
  const isValidConnection = useCallback<IsValidConnection>(
    (conn) => {
      const c = conn as Connection
      if (!c.source || !c.target || c.source === c.target) return false
      const sType = (getNode(c.source)?.data as OpsNodeData | undefined)?.nodeType
      const tType = (getNode(c.target)?.data as OpsNodeData | undefined)?.nodeType
      if (!sType || !tType || !isConnectionAllowed(sType, tType)) return false
      if (c.sourceHandle && c.targetHandle && c.sourceHandle !== c.targetHandle) return false
      return true
    },
    [getNode]
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

  // Création d'un nœud à une position canvas donnée. Factorisé pour servir au
  // drop (position curseur) ET au fallback clavier/clic de la palette (centre).
  const createNodeAt = useCallback(
    async (type: NodeType, pos: { x: number; y: number }) => {
      try {
        await api.createNode(projectId, {
          type,
          name: `${type}-${Math.random().toString(36).slice(2, 6)}`,
          posX: pos.x,
          posY: pos.y,
          config: DEFAULT_CONFIG[type],
        })
        qc.invalidateQueries({ queryKey: ["project", projectId] })
      } catch (err) {
        toast.error("Erreur", { description: (err as Error).message })
      }
    },
    [projectId, qc]
  )

  // Drop d'un élément de la palette -> création du nœud à la position du curseur.
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

  // Fallback NON-drag (clic/clavier) : ajoute le nœud au centre du canvas visible.
  // Indispensable pour l'accessibilité (drag HTML5 inutilisable au clavier).
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

  // Garde-fou destroy : récapitule ce qui sera détruit avant d'appliquer (action
  // irréversible sur des ressources réelles). Pas de "destroy au clic" sec.
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

  // Suppression clavier (Del/Backspace) du nœud ou du lien sélectionné.
  const onKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return
      const target = e.target as HTMLElement
      // Ne pas intercepter la frappe dans un champ de saisie (inspecteur ouvert).
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
        const ok = await prompt({
          title: "Supprimer ce nœud ?",
          description: `« ${node?.name ?? selectedId} » sera retiré du projet. Redéploie pour appliquer à Docker.`,
          confirmText: "Supprimer",
          cancelText: "Annuler",
          variant: "danger",
        })
        if (ok) {
          await api.deleteNode(selectedId).catch(() => {})
          setSelectedId(null)
          qc.invalidateQueries({ queryKey: ["project", projectId] })
        }
      }
    },
    [selectedEdgeId, selectedId, graph, prompt, qc, projectId]
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
      {/* Header allégé : retour + titre + actions de déploiement. */}
      <div className="flex items-center justify-between border-b border-ui-border-base bg-ui-bg-base px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="transparent" onClick={() => navigate("/")} aria-label="Retour aux projets">
            <ArrowLeft />
          </Button>
          <div>
            <Heading level="h2">{graph?.name ?? "…"}</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {graph?.slug} · {graph?.status}
              {placement && placement.servers.length > 0 && (
                <> · Tourne sur : {placement.servers.join(", ")}</>
              )}
            </Text>
          </div>
          {/* Indicateur temps réel : l'opérateur sait si le canvas reflète le réel. */}
          <span
            className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-ui-border-base px-2 py-0.5"
            title={connected ? "Mises à jour en temps réel actives" : "Reconnexion au flux temps réel…"}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-ui-tag-green-icon" : "bg-ui-tag-orange-icon"}`}
            />
            <Text size="xsmall" className="text-ui-fg-subtle">
              {connected ? "Live" : "Reconnexion…"}
            </Text>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {activityLog && (
            <Button variant="transparent" size="small" onClick={() => setActivityOpen((v) => !v)}>
              Activité
            </Button>
          )}
          {canDeploy ? (
            <>
              <Button
                onClick={() => {
                  // Ferme l'inspecteur de nœud/lien ouvert : on déploie l'état
                  // enregistré, pas une édition en cours — éviter toute ambiguïté.
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

      {/* Canvas plein écran ; palette (gauche) et inspecteur (droit) flottent
          par-dessus en overlay sans rétrécir le canvas. */}
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
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onConnectEnd={onConnectEnd}
            onNodeClick={(_e, n) => {
              setSelectedId(n.id)
              setSelectedEdgeId(null)
            }}
            onEdgeClick={(_e, edge) => {
              setSelectedEdgeId(edge.id)
              setSelectedId(null)
            }}
            onPaneClick={() => {
              setSelectedId(null)
              setSelectedEdgeId(null)
            }}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>

          {/* Palette flottante (overlay gauche). */}
          <Palette onAdd={onAddNode} />

          {/* État vide guidé : un projet neuf affiche une consigne au centre. */}
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

          {/* Activité de déploiement : carte flottante en BAS À DROITE (à l'opposé
              de la palette en haut à gauche), façon toast persistant. Déroulée à la
              demande via le bouton « Activité » du header ; fermable. */}
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
              onClose={() => setSelectedId(null)}
              onSaved={() => qc.invalidateQueries({ queryKey: ["project", projectId] })}
              onDeleted={() => {
                setSelectedId(null)
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

/** Wrapper pour fournir le contexte React Flow (requis par screenToFlowPosition). */
export function CanvasPage() {
  const { projectId } = useParams<{ projectId: string }>()
  if (!projectId) return <Navigate to="/" replace />
  return (
    <ReactFlowProvider>
      <CanvasInner projectId={projectId} />
    </ReactFlowProvider>
  )
}
