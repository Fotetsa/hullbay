import { useEffect, useRef, useState } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import type { NodeType, ActualState } from "@bozando-ops/shared"
import { NODE_META } from "./node-meta"

/**
 * Nœud custom du canvas. Icône cohérente par type (NODE_META) + pastille d'état
 * live (running=vert, exited=rouge, missing=gris). Les Handle permettent de tirer
 * des liens entre nœuds. Pour un conteneur multi-replicas, un effet "pile" (cartes
 * décalées derrière la carte principale) + badge ×N rendent visible le scaling —
 * le nombre affiché vient du RUNTIME live (tasks réellement up), pas de la config
 * désirée, pour rester vrai pendant un rolling update ou un crash loop.
 */
export type OpsNodeData = {
  label: string
  nodeType: NodeType
  actualState?: ActualState | null
  /** Config désirée (replicas) — fallback tant qu'aucune mesure live n'est arrivée. */
  desiredReplicas?: number
  /** Nombre de tasks RUNNING réel, poussé par l'observer (event "node.replicas"). */
  runningReplicas?: number
  /**
   * Noms des volumes reliés à ce conteneur (UNIQUEMENT pour le rendu : le modèle
   * de données réel reste Edge(kind="volume") + Node(type="volume") inchangé,
   * voir CanvasPage.tsx). Affiché en badge "emboîté" plutôt qu'en nœud séparé +
   * ligne visible, sur demande explicite ("je veux que ce soit emboîté").
   */
  attachedVolumes?: { id: string; name: string; mountPath?: string }[]
  /**
   * Écart désiré-vs-réel : "pending" = jamais déployé, "drift" = projet partiel/erreur,
   * "deployed" = conforme. Sert au badge "à déployer" (cf. CanvasPage/validate.ts).
   */
  deployState?: "deployed" | "pending" | "drift"
  /**
   * Drop d'un item palette "volume" directement sur CE conteneur — crée le couple
   * Node(volume)+Edge en une seule action. `undefined` pour les nœuds non-conteneur.
   */
  onVolumeDrop?: () => void
  /**
   * PASSERELLE uniquement — la route Caddy n'a pas de cycle de vie conteneur, on
   * affiche donc un état dérivé (cf. validate.ts/gatewayState) + le mapping exposé.
   */
  gatewayState?: "online" | "offline" | "pending"
  /** Domaine exposé (config.domain) affiché sous le libellé de la passerelle. */
  gatewayDomain?: string
  /** Port cible de l'upstream (config.targetPort), affiché en :port. */
  gatewayTargetPort?: number
  /**
   * CONTENEUR — ports publiés sur l'hôte (host:container). S'il y en a, le conteneur
   * est joignable depuis l'extérieur sur ces ports ; sinon il n'est joignable qu'en
   * interne par les autres conteneurs du réseau (DNS). Sert à l'indicateur d'accès.
   */
  publishedPorts?: { host: number; container: number }[]
  /** CONTENEUR — relié à au moins un réseau (sinon isolé). */
  onNetwork?: boolean
  /** Ouvre l'inspecteur du volume embarqué (édition) comme s'il était un nœud libre. */
  onVolumeClick?: (volumeId: string) => void
}

/** Pastille d'état spécifique passerelle : libellé + couleur façon santé upstream. */
const GATEWAY_STATE: Record<
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

/** Libellé court de l'état (lisible, en plus de la couleur — WCAG : pas que la couleur). */
const STATE_LABEL: Record<string, string> = {
  running: "actif",
  exited: "arrêté",
  missing: "absent",
  paused: "pause",
  created: "créé",
  dead: "mort",
}

/** MIME custom posé par Palette.tsx pendant le drag — lisible via `dataTransfer.types`
 *  (pas `getData`, bloqué jusqu'au drop) pour détecter QUEL type est en train d'être glissé. */
const VOLUME_DRAG_MIME = "application/bozando-node-type-volume"

const STATE_COLOR: Record<string, string> = {
  running: "bg-ui-tag-green-icon",
  exited: "bg-ui-tag-red-icon",
  missing: "bg-ui-tag-neutral-icon",
  paused: "bg-ui-tag-orange-icon",
}

/**
 * Couleur par NATURE de lien (pas par type de nœud) : permet de reconnaître au
 * premier coup d'œil quel handle accepte quoi, façon GNS3 (ports typés).
 */
const HANDLE_COLOR: Record<"net-link" | "vol-link" | "gw-link", string> = {
  "net-link": "!bg-ui-tag-blue-icon",
  "vol-link": "!bg-ui-tag-orange-icon",
  "gw-link": "!bg-ui-tag-purple-icon",
}

const HANDLE_SIZE = "!h-2.5 !w-2.5 !border-2 !border-ui-bg-base"

/** Combien de cartes décalées dessiner derrière la carte principale (plafonné, sinon ça déborde). */
const MAX_STACK_LAYERS = 2

export function OpsNode({ data, selected }: NodeProps) {
  const d = data as OpsNodeData
  const Icon = NODE_META[d.nodeType]?.Icon ?? NODE_META.container.Icon
  const stateColor = d.actualState
    ? STATE_COLOR[d.actualState] ?? "bg-ui-tag-neutral-icon"
    : "bg-ui-tag-neutral-icon"

  // Passerelle : état dérivé propre (route + santé upstream), libellé/couleur dédiés.
  const isGateway = d.nodeType === "gateway"
  const gw = GATEWAY_STATE[d.gatewayState ?? "pending"]

  // Replicas : live si connu (mesuré sur les tasks réelles), sinon la config
  // désirée en attendant la première mesure (évite un "×1" trompeur au chargement
  // d'un service qu'on sait avoir 3 replicas configurés).
  const replicas = d.runningReplicas ?? d.desiredReplicas ?? 1
  const isStack = d.nodeType === "container" && replicas > 1
  const stackLayers = Math.min(replicas - 1, MAX_STACK_LAYERS)

  // Flash d'accent sur le badge quand le compte live change (autoscale ou crash) —
  // courte transition (~300ms) plutôt qu'un changement de chiffre sec.
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

  // Highlight de drop : surligné dès l'ENTRÉE du drag d'un volume sur ce nœud
  // (détection DOM native React Flow, pas un calcul manuel de bounding box).
  // dragCounter compense le bug classique navigateur où dragenter/dragleave se
  // déclenchent aussi sur les enfants du nœud (icône, label...), ce qui sinon
  // ferait clignoter le highlight pendant le survol.
  const [dropHighlight, setDropHighlight] = useState(false)
  const dragCounter = useRef(0)
  const canReceiveVolume = d.nodeType === "container" && !!d.onVolumeDrop

  return (
    <div
      className="relative"
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
      {isStack &&
        Array.from({ length: stackLayers }, (_, i) => (
          <div
            key={i}
            aria-hidden
            className="absolute inset-0 rounded-lg border border-ui-border-base bg-ui-bg-subtle transition-all duration-300"
            style={{
              top: (i + 1) * 4,
              left: (i + 1) * 4,
              zIndex: -(i + 1),
            }}
          />
        ))}
      {isStack && (
        <span
          className={`absolute -right-2 -top-2 z-10 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-ui-fg-on-color transition-colors duration-300 ${
            flash ? "bg-ui-tag-blue-icon" : "bg-ui-fg-subtle"
          }`}
          title={`${replicas} replicas`}
        >
          ×{replicas}
        </span>
      )}
      <div
        className={`min-w-[128px] max-w-[200px] rounded-md border bg-ui-bg-base px-2 py-1.5 shadow-elevation-card-rest transition-all duration-150 ${
          dropHighlight
            ? "border-ui-tag-orange-icon ring-2 ring-ui-tag-orange-icon"
            : selected
              ? "border-ui-border-interactive"
              : "border-ui-border-base"
        }`}
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
        </>
      ) : d.nodeType === "network" ? (
        <Handle
          type="target"
          id="net-link"
          position={Position.Left}
          className={`${HANDLE_SIZE} ${HANDLE_COLOR["net-link"]}`}
          title="Réseau"
        />
      ) : d.nodeType === "volume" ? (
        <Handle
          type="target"
          id="vol-link"
          position={Position.Top}
          className={`${HANDLE_SIZE} ${HANDLE_COLOR["vol-link"]}`}
          title="Volume"
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
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-ui-fg-subtle [&_svg]:h-4 [&_svg]:w-4">
          <Icon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-ui-fg-base">{d.label}</div>
          {isGateway && d.gatewayDomain ? (
            // Passerelle : on montre le mapping exposé (domaine -> :port cible)
            // directement sur le nœud, façon GNS3/Azure (le lien porte ses ports).
            <div
              className="truncate text-[10px] leading-tight text-ui-fg-subtle"
              title={`${d.gatewayDomain}${d.gatewayTargetPort ? ` -> :${d.gatewayTargetPort}` : ""}`}
            >
              {d.gatewayDomain}
              {d.gatewayTargetPort ? ` :${d.gatewayTargetPort}` : ""}
            </div>
          ) : (
            <div className="text-[10px] leading-tight text-ui-fg-muted">
              {NODE_META[d.nodeType]?.label ?? d.nodeType}
            </div>
          )}
        </div>
        {isGateway ? (
          // État LOGIQUE de la route (en ligne / cible hors-ligne / à déployer),
          // pas le cycle de vie conteneur : une route Caddy n'est jamais "actif".
          <span
            className="inline-flex items-center gap-1"
            aria-label={`Passerelle : ${gw.label}`}
            title={gw.title}
          >
            <span className={`inline-block h-2 w-2 rounded-full ${gw.dot}`} />
            <span className={`text-[10px] leading-tight ${gw.text}`}>{gw.label}</span>
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

      {/* Écart désiré-vs-réel : badge explicite "à déployer" (pas seulement une
          couleur). Inutile pour la passerelle : sa pastille porte déjà son état. */}
      {!isGateway && (d.deployState === "pending" || d.deployState === "drift") && (
        <div className="mt-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full bg-ui-tag-orange-bg px-1.5 py-0.5 text-[10px] font-medium text-ui-tag-orange-text"
            title={
              d.deployState === "pending"
                ? "Présent dans le projet mais pas encore déployé"
                : "Le déploiement diverge du désiré"
            }
          >
            <span className="h-1.5 w-1.5 rounded-full bg-ui-tag-orange-icon" />
            à déployer
          </span>
        </div>
      )}
      {/* Accès (conteneur) : publié sur l'hôte (joignable navigateur) vs interne seul. */}
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
    </div>
  )
}
