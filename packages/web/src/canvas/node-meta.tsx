import { CubeSolid, ServerStack, CircleStack, GlobeEurope } from "@medusajs/icons"
import type { IconProps } from "@medusajs/icons/dist/types"
import type { NodeType } from "@bozando-ops/shared"

/**
 * Métadonnées d'affichage par type de nœud — source unique partagée par la
 * Palette et OpsNode (icônes cohérentes qui reflètent vraiment le composant).
 *  - container : un cube (une unité déployable)
 *  - network   : une pile de serveurs reliés
 *  - volume    : une pile disque (stockage)
 *  - gateway   : un globe (exposition internet)
 */
export const NODE_META: Record<
  NodeType,
  { label: string; hint: string; Icon: React.ComponentType<IconProps> }
> = {
  container: { label: "Conteneur", hint: "Une image Docker", Icon: CubeSolid },
  network: { label: "Réseau", hint: "Relie des conteneurs", Icon: ServerStack },
  volume: { label: "Volume", hint: "Stockage persistant", Icon: CircleStack },
  gateway: { label: "Passerelle", hint: "Exposition internet", Icon: GlobeEurope },
}
