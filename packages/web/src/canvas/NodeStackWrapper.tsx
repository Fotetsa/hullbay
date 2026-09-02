import { colorForSwarmNode, TAG_CLASSES } from "../lib/clusterNodeColors"
import type { NodePlacement } from "../lib/useOpsSocket"

/**
 * Rayon de coin partagé par TOUTES les couches (carte principale + pile) —
 * une seule constante pour garantir qu'aucune couche n'ait un arrondi
 * différent de la carte du dessus. Doit rester alignée avec le `rounded-2xl`
 * (16px) de la carte principale dans OpsNode.tsx — si tu changes l'un,
 * change l'autre.
 */
const STACK_RADIUS = "16px"
const MAX_STACK_LAYERS = 4
/** Décalage diagonal (px) entre deux couches consécutives de la pile. */
const STACK_OFFSET = 8

export default function NodeStackWrapper({
  replicas,
  placements,
  clusterNodeOrder = [],
  flash,
  children,
}: {
  replicas: number
  placements?: NodePlacement[]
  clusterNodeOrder?: string[]
  flash?: boolean
  children: React.ReactNode
}) {
  const stackLayers = Math.min(Math.max(replicas - 1, 0), MAX_STACK_LAYERS)

  return (
    <div className="relative">
      {stackLayers > 0 &&
        Array.from({ length: stackLayers }, (_, i) => {
          const placement = placements?.[i + 1]
          const color = placement ? colorForSwarmNode(placement.swarmNodeId, clusterNodeOrder) : "neutral"
          const cls = TAG_CLASSES[color]
          const offset = (i + 1) * STACK_OFFSET
          return (
            <div
              key={placement?.taskId ?? i}
              aria-hidden
              title={placement ? `Replica sur ${placement.swarmNodeId}` : undefined}
              // AUCUNE classe `rounded-*` Tailwind ici : le rayon vient
              // exclusivement de `style.borderRadius` ci-dessous, sur la MÊME
              // constante STACK_RADIUS que la carte principale — garantit un
              // arrondi identique au pixel près, plutôt que deux valeurs
              // Tailwind/inline qui pourraient un jour diverger.
              className={`absolute inset-0 border bg-ui-bg-subtle shadow-elevation-card-rest ${cls.border}`}
              style={{
                zIndex: -(i + 1),
                opacity: 1 - (i + 1) * 0.14,
                // `inset-0` donne déjà à chaque couche EXACTEMENT la même
                // largeur/hauteur que la carte principale (elle épouse la
                // boîte du conteneur `relative` parent) — pas de `scale`,
                // donc "même taille" est garanti, pas approximé.
                transform: `translate(${offset}px, ${offset}px)`,
                borderRadius: STACK_RADIUS,
              }}
            />
          )
        })}

      <div>{children}</div>
    </div>
  )
}