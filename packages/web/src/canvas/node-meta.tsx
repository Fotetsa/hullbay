import { CubeSolid, ServerStack, CircleStack, GlobeEurope, CircleStackSolid } from "@medusajs/icons"
import type { IconProps } from "@medusajs/icons/dist/types"
import type { NodeType } from "@hullbay/shared"

/**
 * Métadonnées d'affichage par type de nœud — source unique partagée par la
 * Palette et OpsNode (icônes cohérentes qui reflètent vraiment le composant).
 *  - container : un cube (une unité déployable)
 *  - network   : une pile de serveurs reliés
 *  - volume    : une pile disque (stockage)
 *  - gateway   : un globe (exposition internet)
 *  - database  : une pile disque pleine (base de données managée)
 */
export const NODE_META: Record<
  NodeType,
  { label: string; hint: string; Icon: React.ComponentType<IconProps> }
> = {
  container: { label: "Conteneur", hint: "Une image Docker", Icon: CubeSolid },
  network: { label: "Réseau", hint: "Relie des conteneurs", Icon: ServerStack },
  volume: { label: "Volume", hint: "Stockage persistant", Icon: CircleStack },
  gateway: { label: "Passerelle", hint: "Exposition internet", Icon: GlobeEurope },
  database: { label: "Base de données", hint: "Base managée", Icon: CircleStackSolid },
}
