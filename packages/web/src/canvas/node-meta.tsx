import { CubeSolid, ServerStack, ArchiveBox, GlobeEurope, CircleStackSolid } from "@medusajs/icons"
import type { IconProps } from "@medusajs/icons/dist/types"
import type { NodeType } from "@hullbay/shared"

/**
 * Métadonnées d'affichage par type de nœud — source unique partagée par la
 * Palette et OpsNode (icônes cohérentes qui reflètent vraiment le composant).
 *
 * Icônes basées sur les STANDARDS DEVOPS réels :
 *  - container   : CubeSolid - standard Docker/Kubernetes (conteneur déployable)
 *  - network     : ServerStack - pile de serveurs interconnectés (réseau Swarm)
 *  - volume      : ArchiveBox - boîte de stockage (persistent storage)
 *  - gateway     : GlobeEurope - globe (exposition internet/réseau externe)
 *  - database    : CircleStackSolid - cylindre standard (LE standard universel 
 *                  pour les bases de données depuis des décennies)
 */
export const NODE_META: Record<
  NodeType,
  { label: string; hint: string; Icon: React.ComponentType<IconProps> }
> = {
  container: { label: "Conteneur", hint: "Une image Docker", Icon: CubeSolid },
  network: { label: "Réseau", hint: "Relie des conteneurs", Icon: ServerStack },
  volume: { label: "Volume", hint: "Stockage persistant", Icon: ArchiveBox },
  gateway: { label: "Passerelle", hint: "Exposition internet", Icon: GlobeEurope },
  database: { label: "Base de données", hint: "Base managée", Icon: CircleStackSolid },
}