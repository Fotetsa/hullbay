import { useEffect, useRef, useState } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import type { NodeType, ActualState } from "@hullbay/shared"
import { NODE_META } from "./node-meta"
import { colorForSwarmNode, TAG_CLASSES } from "../lib/clusterNodeColors"
import NodeStackWrapper from "./NodeStackWrapper"
import type { NodePlacement } from "../lib/useOpsSocket"

export type OpsNodeData = {
  label: string
  nodeType: NodeType
  actualState?: ActualState | null
  desiredReplicas?: number
  runningReplicas?: number
  attachedVolumes?: { id: string; name: string; mountPath?: string }[]
  deployState?: "deployed" | "pending" | "drift"
  onVolumeDrop?: () => void
  gatewayState?: "online" | "offline" | "pending"
  gatewayDomain?: string
  gatewayTargetPort?: number
  publishedPorts?: { host: number; container: number }[]
  onNetwork?: boolean
  onVolumeClick?: (volumeId: string) => void
  dbSummary?: { engine: string; mode: string; replicas: number; consensus?: number }
<<<<<<< HEAD
  placements?: NodePlacement[]
  clusterNodeOrder?: string[]
=======
  /**
   * NETWORK — vrai si ce nœud est le RÉSEAU d'une base (créé au drop de la base,
   * edge kind="network" vers un nœud database). Un tel réseau n'est pas un réseau
   * normal : son point de liaison devient le handle VERT "db-link" (la connexion
   * y aboutit à une relation database, pas à une liaison réseau classique).
   */
  isDbLinkedNetwork?: boolean
>>>>>>> upstream/master
}

const GATEWAY_STATE: Record <
  NonNullable<OpsNodeData["gatewayState"]>,
  { label: string; dot: string; text: string; title: string }
> = {
  online: {
    label: "en ligne",
    dot: "bg-ui-tag-green-icon",
    text: "text-ui-tag-green-text",
    title: "Route active et conteneur cible joignable : le domaine résout vers l'upstream.",
  },
  offline: {
    label: "cible hors-ligne",
    dot: "bg-ui-tag-orange-icon",
    text: "text-ui-tag-orange-text",
    title: "Route déployée mais conteneur cible absent/arrêté : le domaine renverrait 502.",
  },
  pending: {
    label: "à déployer",
    dot: "bg-ui-tag-neutral-icon",
    text: "text-ui-fg-muted",
    title: "Route pas encore appliquée dans Caddy.",
  },
}

const STATE_LABEL: Record<string, string> = {
  running: "actif",
  exited: "arrêté",
  missing: "absent",
  paused: "pause",
  created: "créé",
  dead: "mort",
}

const VOLUME_DRAG_MIME = "application/bozando-node-type-volume"

const STATE_COLOR: Record<string, string> = {
  running: "bg-ui-tag-green-icon",
  exited: "bg-ui-tag-red-icon",
  missing: "bg-ui-tag-neutral-icon",
  paused: "bg-ui-tag-orange-icon",
}

const NODE_ICON_STYLE: Record<NodeType, string> = {
  // Use neutral black background for all node icons to reduce chromatic
  // noise in the canvas. Icons themselves remain visible in white.
  container: "bg-black text-white",
  network: "bg-black text-white",
  volume: "bg-black text-white",
  gateway: "bg-black text-white",
  database: "bg-black text-white",
}

const STATE_CHIP: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: "bg-ui-tag-green-bg", text: "text-ui-tag-green-text", dot: "bg-ui-tag-green-icon" },
  exited: { bg: "bg-ui-tag-red-bg", text: "text-ui-tag-red-text", dot: "bg-ui-tag-red-icon" },
  missing: { bg: "bg-ui-tag-neutral-bg", text: "text-ui-fg-muted", dot: "bg-ui-tag-neutral-icon" },
  paused: { bg: "bg-ui-tag-orange-bg", text: "text-ui-tag-orange-text", dot: "bg-ui-tag-orange-icon" },
}
const GATEWAY_CHIP: Record <
  NonNullable<OpsNodeData["gatewayState"]>,
  { bg: string; text: string; dot: string }
> = {
  online: { bg: "bg-ui-tag-green-bg", text: "text-ui-tag-green-text", dot: "bg-ui-tag-green-icon" },
  offline: { bg: "bg-ui-tag-orange-bg", text: "text-ui-tag-orange-text", dot: "bg-ui-tag-orange-icon" },
  pending: { bg: "bg-ui-tag-neutral-bg", text: "text-ui-fg-muted", dot: "bg-ui-tag-neutral-icon" },
}

const HANDLE_COLOR: Record<"net-link" | "vol-link" | "gw-link" | "db-link", string> = {
  "net-link": "!bg-ui-tag-blue-icon",
  "vol-link": "!bg-ui-tag-orange-icon",
  "gw-link": "!bg-ui-tag-purple-icon",
  "db-link": "!bg-ui-tag-green-icon",
}

const HANDLE_SIZE = "!h-2.5 !w-2.5 !border-2 !border-ui-bg-base"

const MAX_STACK_LAYERS = 4

export function OpsNode({ data, selected }: NodeProps) {
  const d = data as OpsNodeData
  const Icon = NODE_META[d.nodeType]?.Icon ?? NODE_META.container.Icon
  const stateColor = d.actualState
    ? STATE_COLOR[d.actualState] ?? "bg-ui-tag-neutral-icon"
    : "bg-ui-tag-neutral-icon"

  const isGateway = d.nodeType === "gateway"
  const gw = GATEWAY_STATE[d.gatewayState ?? "pending"]

  const replicas = d.runningReplicas ?? d.desiredReplicas ?? 1
  const isStack = d.nodeType === "container" && replicas > 1
  const stackLayers = Math.min(replicas - 1, MAX_STACK_LAYERS)

  const [flash, setFlash] = useState(false)
  const prevReplicas = useRef(d.runningReplicas)
  useEffect(() => {
    if (prevReplicas.current !== undefined && prevReplicas.current !== d.runningReplicas) {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 300)
      prevReplicas.current = d.runningReplicas
      return () => clearTimeout(t)
    }
    prevReplicas.current = d.runningReplicas
  }, [d.runningReplicas])

  const [dropHighlight, setDropHighlight] = useState(false)
  const dragCounter = useRef(0)
  const canReceiveVolume = d.nodeType === "container" && !!d.onVolumeDrop

  const clusterNodeOrder = d.clusterNodeOrder ?? []

  return (
    <div
      className="group relative"
      onDragEnter={
        canReceiveVolume
          ? (e) => {
              if (!e.dataTransfer.types.includes(VOLUME_DRAG_MIME)) return
              dragCounter.current += 1
              setDropHighlight(true)
            }
          : undefined
      }
      onDragOver={
        canReceiveVolume
          ? (e) => {
              if (!e.dataTransfer.types.includes(VOLUME_DRAG_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = "copy"
            }
          : undefined
      }
      onDragLeave={
        canReceiveVolume
          ? (e) => {
              if (!e.dataTransfer.types.includes(VOLUME_DRAG_MIME)) return
              dragCounter.current = Math.max(0, dragCounter.current - 1)
              if (dragCounter.current === 0) setDropHighlight(false)
            }
          : undefined
      }
      onDrop={
        canReceiveVolume
          ? (e) => {
              if (!e.dataTransfer.types.includes(VOLUME_DRAG_MIME)) return
              e.preventDefault()
              e.stopPropagation()
              dragCounter.current = 0
              setDropHighlight(false)
              d.onVolumeDrop?.()
            }
          : undefined
      }
    >
      <NodeStackWrapper
        replicas={replicas}
        placements={d.placements}
        clusterNodeOrder={clusterNodeOrder}
        flash={flash}
      >
        <div
          className={`min-w-[160px] max-w-[220px] border bg-ui-bg-base p-3 shadow-elevation-card-rest transition-all duration-150 hover:shadow-elevation-card-hover ${
            dropHighlight
              ? "border-ui-tag-orange-icon ring-2 ring-ui-tag-orange-icon"
              : selected
                ? "border-ui-border-interactive ring-1 ring-ui-border-interactive"
                : "border-ui-border-base"
          }`}
          style={{ borderRadius: "16px" }}
        >
      {d.nodeType === "container" ? (
        <>
          <Handle
            type="source"
            id="net-link"
            position={Position.Left}
            className={`${HANDLE_SIZE} ${HANDLE_COLOR["net-link"]}`}
            title="Réseau"
          />
          <Handle
            type="source"
            id="vol-link"
            position={Position.Bottom}
            className={`${HANDLE_SIZE} ${HANDLE_COLOR["vol-link"]}`}
            title="Volume"
          />
          <Handle
            type="source"
            id="gw-link"
            position={Position.Right}
            className={`${HANDLE_SIZE} ${HANDLE_COLOR["gw-link"]}`}
            title="Passerelle"
          />
          <Handle
            type="source"
            id="db-link"
            position={Position.Top}
            className={`${HANDLE_SIZE} ${HANDLE_COLOR["db-link"]}`}
            title="Base de données (dépendance applicative)"
          />
        </>
      ) : d.nodeType === "network" ? (
<<<<<<< HEAD
        <Handle
          type="target"
          id="net-link"
          position={Position.Left}
          className={`${HANDLE_SIZE} ${HANDLE_COLOR["net-link"]}`}
          title="Réseau"
        />
=======
        d.isDbLinkedNetwork ? (
          <>
            {/* Réseau d'une base : point de connexion VERT — connecter ici
                crée la relation database avec la base liée (edge database
                conteneur↔base), pas un edge réseau conteneur↔network. */}
            <Handle
              type="target"
              id="db-link"
              position={Position.Left}
              className={`${HANDLE_SIZE} ${HANDLE_COLOR["db-link"]}`}
              title="Base de données (dépendance applicative)"
            />
            <Handle
              type="source"
              id="db-link"
              position={Position.Right}
              className={`${HANDLE_SIZE} ${HANDLE_COLOR["db-link"]}`}
              title="Base de données (dépendance applicative)"
            />
          </>
        ) : (
          <Handle
            type="target"
            id="net-link"
            position={Position.Left}
            className={`${HANDLE_SIZE} ${HANDLE_COLOR["net-link"]}`}
            title="Réseau"
          />
        )
>>>>>>> upstream/master
      ) : d.nodeType === "volume" ? (
        <Handle
          type="target"
          id="vol-link"
          position={Position.Top}
          className={`${HANDLE_SIZE} ${HANDLE_COLOR["vol-link"]}`}
          title="Volume"
        />
      ) : d.nodeType === "database" ? (
        <Handle
          type="target"
          id="db-link"
          position={Position.Left}
          className={`${HANDLE_SIZE} ${HANDLE_COLOR["db-link"]}`}
          title="Base de données (dépendance applicative)"
        />
      ) : (
        <Handle
          type="target"
          id="gw-link"
          position={Position.Left}
          className={`${HANDLE_SIZE} ${HANDLE_COLOR["gw-link"]}`}
          title="Passerelle"
        />
      )}
      <div className="flex items-start gap-2.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg [&_svg]:h-4 [&_svg]:w-4 ${NODE_ICON_STYLE[d.nodeType]}`}
        >
          <Icon />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-[13px] font-semibold leading-tight text-ui-fg-base">{d.label}</div>
          {isGateway && d.gatewayDomain ? (
            <div
              className="truncate text-[10px] leading-tight text-ui-fg-subtle"
              title={`${d.gatewayDomain}${d.gatewayTargetPort ? ` -> :${d.gatewayTargetPort}` : ""}`}
            >
              {d.gatewayDomain}
              {d.gatewayTargetPort ? ` :${d.gatewayTargetPort}` : ""}
            </div>
          ) : d.nodeType === "database" && d.dbSummary ? (
            <div
              className="truncate text-[10px] leading-tight text-ui-fg-subtle"
              title={
                d.dbSummary.mode === "ha"
                  ? `${d.dbSummary.engine} HA — ${d.dbSummary.replicas} membre(s) data` +
                    (d.dbSummary.consensus
                      ? `, ${d.dbSummary.consensus} nœud(s) de coordination`
                      : "")
                  : `${d.dbSummary.engine} single — 1 nœud`
              }
            >
              {d.dbSummary.engine} · {d.dbSummary.mode}
              {d.dbSummary.mode === "ha" ? ` · ${d.dbSummary.replicas} membres` : ""}
            </div>
          ) : (
            <div className="text-[10px] leading-tight text-ui-fg-muted">
              {NODE_META[d.nodeType]?.label ?? d.nodeType}
            </div>
          )}
        </div>
        {isGateway ? (
          <span
            className="inline-flex items-center gap-1"
            aria-label={`Passerelle : ${gw.label}`}
            title={gw.title}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${gw.dot}`} />
            {/* Avoid duplicating the bottom 'à déployer' badge: when gateway is
                pending we only show the dot (no repeated label). */}
            {gw.label !== "à déployer" && (
              <span className={`text-[10px] leading-tight ${gw.text}`}>{gw.label}</span>
            )}
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1"
            aria-label={`État : ${d.actualState ? STATE_LABEL[d.actualState] ?? d.actualState : "non déployé"}`}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${stateColor}`} />
            <span className="text-[10px] leading-tight text-ui-fg-muted">
              {d.actualState ? STATE_LABEL[d.actualState] ?? d.actualState : "—"}
            </span>
          </span>
        )}
      </div>
<<<<<<< HEAD
      {( (!isGateway && (d.deployState === "pending" || d.deployState === "drift")) || (isGateway && d.gatewayState === "pending") ) && (
=======

      {/* Écart désiré-vs-réel : badge explicite "à déployer" (pas seulement une
          couleur). Inutile pour la passerelle : sa pastille porte déjà son état. */}
      {!isGateway && !d.isDbLinkedNetwork && (d.deployState === "pending" || d.deployState === "drift") && (
>>>>>>> upstream/master
        <div className="mt-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full bg-ui-tag-orange-bg px-1.5 py-0.5 text-[10px] font-medium text-ui-tag-orange-text"
            title={
              isGateway
                ? "Route pas encore appliquée dans Caddy."
                : d.deployState === "pending"
                ? "Présent dans le projet mais pas encore déployé"
                : "Le déploiement diverge du désiré"
            }
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ui-tag-orange-icon" />
            à déployer
          </span>
        </div>
      )}
      {d.nodeType === "container" && (
        d.publishedPorts?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {d.publishedPorts.map((p) => (
              <span
                key={p.host}
                className="inline-flex items-center gap-1 rounded-full bg-ui-tag-green-bg px-1.5 py-0.5 text-[10px] font-medium text-ui-tag-green-text"
                title={`Publié sur l'hôte : accessible via le port ${p.host} (-> ${p.container} dans le conteneur)`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-ui-tag-green-icon" />
                :{p.host}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-1.5">
            <span
              className="inline-flex items-center gap-1 text-[10px] leading-tight text-ui-fg-muted"
              title={
                d.onNetwork
                  ? "Aucun port publié : joignable seulement en interne par les autres conteneurs du réseau (par nom DNS)."
                  : "Aucun port publié et aucun réseau : conteneur isolé, joignable seulement via une passerelle."
              }
            >
              <span className="h-1.5 w-1.5 rounded-full bg-ui-tag-neutral-icon" />
              interne
            </span>
          </div>
        )
      )}
      {!!d.attachedVolumes?.length && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {d.attachedVolumes.map((v) => {
            const VolIcon = NODE_META.volume.Icon
            return (
              <button
                key={v.id}
                type="button"
                className="nodrag inline-flex items-center gap-1 rounded-full bg-ui-tag-orange-bg px-1.5 py-0.5 text-[10px] text-ui-tag-orange-text transition-colors hover:bg-ui-tag-orange-bg-hover"
                title={`Volume « ${v.name} » monté sur ${v.mountPath || `/data/${v.name}`} — clic pour éditer`}
                onClick={(e) => {
                  e.stopPropagation()
                  d.onVolumeClick?.(v.id)
                }}
              >
                <VolIcon className="h-3 w-3 text-ui-tag-orange-icon" />
                {v.name}
              </button>
            )
          })}
        </div>
      )}
      </div>
      </NodeStackWrapper>
    </div>
  )
}