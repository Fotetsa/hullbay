/**
 * Couleur déterministe par nœud Swarm, partagée entre la barre de statut cluster
 * (ClusterNodesBar) et la pile 3D des replicas (OpsNode) — SOURCE UNIQUE, pour que
 * le même nœud physique porte toujours la même couleur partout dans le canvas.
 *
 * Palette : les 6 couleurs "tag" du design system Medusa UI (vérifiées dans
 * @medusajs/ui-preset : bg/border/icon/text pour blue, green, neutral, orange,
 * purple, red — c'est TOUTE la palette tag disponible, il n'y en a pas d'autres).
 * Au-delà de 6 nœuds Swarm, le cycle se répète (rare : les clusters Swarm de ce
 * projet visent des tailles de quorum impaires 3/5/7, un cycle de 6 suffit dans
 * l'immense majorité des cas et reste lisible).
 *
 * IMPORTANT Tailwind : ces classes doivent être écrites EN TOUTES LETTRES quelque
 * part dans le code scanné (elles le sont ci-dessous, dans TAG_CLASSES) — le
 * scanner JIT de Tailwind ne résout PAS des classes construites par template
 * string à runtime (`` `bg-ui-tag-${color}-bg` `` ne fonctionnerait pas une fois
 * buildé). Toujours passer par TAG_CLASSES[color], jamais par concaténation.
 */
export const CLUSTER_TAG_COLORS = ["blue", "green", "purple", "orange", "red", "neutral"] as const
export type ClusterTagColor = (typeof CLUSTER_TAG_COLORS)[number]

export const TAG_CLASSES: Record <
  ClusterTagColor,
  { bg: string; border: string; icon: string; text: string }
> = {
  blue: {
    bg: "bg-ui-tag-blue-bg",
    border: "border-ui-tag-blue-border",
    icon: "bg-ui-tag-blue-icon",
    text: "text-ui-tag-blue-text",
  },
  green: {
    bg: "bg-ui-tag-green-bg",
    border: "border-ui-tag-green-border",
    icon: "bg-ui-tag-green-icon",
    text: "text-ui-tag-green-text",
  },
  purple: {
    bg: "bg-ui-tag-purple-bg",
    border: "border-ui-tag-purple-border",
    icon: "bg-ui-tag-purple-icon",
    text: "text-ui-tag-purple-text",
  },
  orange: {
    bg: "bg-ui-tag-orange-bg",
    border: "border-ui-tag-orange-border",
    icon: "bg-ui-tag-orange-icon",
    text: "text-ui-tag-orange-text",
  },
  red: {
    bg: "bg-ui-tag-red-bg",
    border: "border-ui-tag-red-border",
    icon: "bg-ui-tag-red-icon",
    text: "text-ui-tag-red-text",
  },
  neutral: {
    bg: "bg-ui-tag-neutral-bg",
    border: "border-ui-tag-neutral-border",
    icon: "bg-ui-tag-neutral-icon",
    text: "text-ui-tag-neutral-text",
  },
}

/**
 * Résout la couleur d'un nœud Swarm à partir de sa position dans la liste ORDONNÉE
 * des nœuds du cluster (`ClusterHealth.nodes`, déjà triée côté back par l'ordre
 * Docker/Swarm — stable tant que la topologie du cluster ne change pas).
 * `orderedSwarmNodeIds` doit venir de la MÊME requête `api.clusterHealth()` que
 * celle utilisée pour afficher la légende (ClusterNodesBar), pour rester cohérent.
 */
export function colorForSwarmNode(
  swarmNodeId: string | undefined,
  orderedSwarmNodeIds: string[]
): ClusterTagColor {
  if (!swarmNodeId) return "neutral"
  const idx = orderedSwarmNodeIds.indexOf(swarmNodeId)
  return CLUSTER_TAG_COLORS[idx < 0 ? 0 : idx % CLUSTER_TAG_COLORS.length]
}