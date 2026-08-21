import type { DatabaseConfig, DatabaseEngine, DatabaseMode } from "@hullbay/shared"

/**
 * Règles de topologie PAR MOTEUR .
 *
 * PRINCIPE : les règles de replicas sont propres à chaque moteur.
 * AUCUNE règle globale « impair » ici — chaque moteur liste ses valeurs
 * autorisées. Les data-replicas et les replicas de consensus sont des axes
 * DISTINCTS (spec §13) : consensus = null signifie que le moteur n'a pas de
 * consensus découplé (Group Replication / replica set comptent dans les membres).
 */

export interface EngineTopology {
  engine: DatabaseEngine
  /** Réplicas data autorisés en mode single. */
  singleReplicas: number[]
  /** Réplicas data autorisés en mode ha. */
  haReplicas: number[]
  /** Défaut de replicas consensus par mode (null = pas de consensus). */
  consensus: { single: number | null; ha: number | null }
  /** Valeurs de consensus autorisées quand le moteur en a un. */
  consensusOptions: number[]
}

export const ENGINE_TOPOLOGY: Record<DatabaseEngine, EngineTopology> = {
  postgres: {
    engine: "postgres",
    singleReplicas: [1],
    haReplicas: [3, 5, 7],
    consensus: { single: null, ha: 3 },
    consensusOptions: [3, 5],
  },
  mysql: {
    engine: "mysql",
    singleReplicas: [1],
    haReplicas: [3, 5],
    consensus: { single: null, ha: null },
    consensusOptions: [],
  },
  mongodb: {
    engine: "mongodb",
    singleReplicas: [1],
    haReplicas: [3, 5],
    consensus: { single: null, ha: null },
    consensusOptions: [],
  },
  redis: {
    engine: "redis",
    singleReplicas: [1],
    haReplicas: [2, 3, 4, 5],
    consensus: { single: null, ha: 3 },
    consensusOptions: [3, 5],
  },
}

/** Réplicas data autorisés pour un moteur/mode donnés. */
export function allowedReplicas(engine: DatabaseEngine, mode: DatabaseMode): number[] {
  const rule = ENGINE_TOPOLOGY[engine]
  return mode === "ha" ? rule.haReplicas : rule.singleReplicas
}

/** Défaut de replicas data pour un moteur/mode. */
export function defaultReplicas(engine: DatabaseEngine, mode: DatabaseMode): number {
  return mode === "ha" ? (ENGINE_TOPOLOGY[engine].haReplicas[0] ?? 1) : 1
}

/** Réplicas data effectifs pour un moteur/mode (défaut si non précisé). */
export function effectiveReplicas(config: DatabaseConfig): number {
  return config.topology.replicas ?? defaultReplicas(config.engine, config.mode)
}

/** Réplicas consensus effectifs (défaut du moteur si non précisé). */
export function effectiveConsensus(config: DatabaseConfig): number | null {
  const rule = ENGINE_TOPOLOGY[config.engine]
  return config.topology.consensusReplicas ?? rule.consensus[config.mode]
}

/** Liste des problèmes de topologie (vide = valide). */
export function validateTopology(config: DatabaseConfig): string[] {
  const issues: string[] = []
  const rule = ENGINE_TOPOLOGY[config.engine]
  const replicas = effectiveReplicas(config)
  const allowed = allowedReplicas(config.engine, config.mode)

  if (!allowed.includes(replicas)) {
    issues.push(
      `${config.engine}/${config.mode} : replicas doit être dans [${allowed.join(", ")}]`
    )
  }

  const consensus = config.topology.consensusReplicas
  if (consensus !== undefined) {
    if (rule.consensus[config.mode] === null) {
      issues.push(
        `${config.engine}/${config.mode} n'a pas de consensus découplé (consensusReplicas interdit)`
      )
    } else if (!rule.consensusOptions.includes(consensus)) {
      issues.push(
        `${config.engine} : consensusReplicas doit être dans [${rule.consensusOptions.join(", ")}]`
      )
    }
  }

  return issues
}
