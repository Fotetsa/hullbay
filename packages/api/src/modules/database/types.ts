import type {
  DatabaseConfig,
  DatabaseEngine,
} from "@hullbay/shared"
import { z } from "zod"
import {
  ContainerConfigSchema,
  NetworkConfigSchema,
  VolumeConfigSchema,
} from "@hullbay/shared"

/** Ré-export des types shared consommés par les providers (contrat du module). */
export type {
  ContainerConfig,
  DatabaseConfig,
  DatabaseEngine,
  NetworkConfig,
  VolumeConfig,
} from "@hullbay/shared"

/**
 * Types INPUT des schémas state : les configs générées par les providers sont
 * partielles (défauts absents). La normalisation (défauts appliqués) a lieu à
 * l'expansion via parseNodeConfig — même chemin que les nœuds persistés.
 */
export type ContainerConfigInput = z.input<typeof ContainerConfigSchema>
export type NetworkConfigInput = z.input<typeof NetworkConfigSchema>
export type VolumeConfigInput = z.input<typeof VolumeConfigSchema>

/**
 * Module database — expansion de topologie PURE.
 *
 * PRINCIPE  : ce module ne peut NI appeler Docker/Nest, NI accéder à
 * Prisma, NI maintenir d'état. Il décrit ce qui doit exister ; le reconciler
 * existant décide comment le réconcilier. L'expansion est en mémoire : les
 * nodeIds synthétiques générés ici n'existent qu'au moment du deploy/plan/destroy.
 */

/** Rôle d'une ressource générée (label bozando.database.role). */
export type DatabaseRole =
  | "member"
  | "consensus"
  | "writer"
  | "reader"
  | "network"
  | "volume"

export type GeneratedResource =
  | {
      kind: "container"
      nodeId: string
      name: string
      role: DatabaseRole
      index: number
      config: ContainerConfigInput
    }
  | {
      kind: "network"
      nodeId: string
      name: string
      role: DatabaseRole
      index: number
      config: NetworkConfigInput
    }
  | {
      kind: "volume"
      nodeId: string
      name: string
      role: DatabaseRole
      index: number
      /** true si volume de données (rétention, label bozando.database.data). */
      data: boolean
      config: VolumeConfigInput
    }

/** Edge interne généré (membre↔réseau, membre↔volume). */
export interface GeneratedEdge {
  source: string
  target: string
  kind: "network" | "volume"
  /** Config du lien (ex: mountPath pour un volume). */
  config?: { mountPath?: string; readOnly?: boolean }
}

/**
 * Contrat de connexion exposé aux conteneurs applicatifs dépendants.
 * Le mot de passe n'apparaît jamais ici : uniquement une référence au secret.
 */
export interface ConnectionEndpoint {
  role: "writer" | "reader"
  /** Nom de service Swarm (résolu par le DNS du réseau overlay). */
  host: string
  port: number
  database: string
  username: string
  /** Référence au Docker Secret — jamais la valeur. */
  passwordSecretRef: string
  /** Variables d'environnement injectées dans les conteneurs applicatifs dépendants. */
  env: Record<string, string>
}

export interface ExpandedDatabase {
  resources: GeneratedResource[]
  edges: GeneratedEdge[]
  connections: ConnectionEndpoint[]
  /** Config-secrets générés, nommés avec un suffixe dérivé du contenu. */
  generatedSecrets: { name: string; data: string }[]
}

export interface ExpansionContext {
  /** ID du nœud database parent (origine des nodeIds synthétiques). */
  parentNodeId: string
  /** Nœud database parent (name/type/config). */
  parentNode: DatabaseNode
  /** Slug du projet (préfixe des noms de ressources boz_<slug>_). */
  projectSlug: string
}

export interface DatabaseNode {
  id: string
  name: string
  type: "database"
  config: DatabaseConfig
}

export interface DatabaseProvider {
  engine: DatabaseEngine
  /** Validation moteur-spécifique (topologie, version, cohérence). Lève si invalide. */
  validate(config: DatabaseConfig): void
  /** Expansion pure et déterministe (aucun accès Docker/Prisma). */
  expand(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase
  /** Contrat de connexion exposé aux conteneurs applicatifs. */
  connection(config: DatabaseConfig, ctx: ExpansionContext): ConnectionEndpoint[]
}
