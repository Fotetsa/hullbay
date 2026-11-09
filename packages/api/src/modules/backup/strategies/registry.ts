import type { BackupTargetKind } from "@hullbay/shared"
import { postgresStrategy } from "./postgres"
import { mysqlStrategy } from "./mysql"
import { mongodbStrategy } from "./mongodb"
import { redisStrategy } from "./redis"
import { volumeStrategy } from "./volume"
import type { BackupStrategy } from "./types"

/**
 * Registry de stratégies : `id → BackupStrategy`.
 *
 * Le Backup Engine ne fait jamais de `switch (engine)` : il résout par
 * `strategyId` ou par `targetKind`. Ajouter une source = enregistrer une
 * stratégie, sans toucher au moteur.
 */

const byId = new Map<string, BackupStrategy>()

export function registerStrategy(strategy: BackupStrategy): void {
  byId.set(strategy.id, strategy)
}

export function getStrategy(id: string): BackupStrategy {
  const strategy = byId.get(id)
  if (!strategy) throw new Error(`stratégie inconnue : ${id}`)
  return strategy
}

export function strategiesFor(kind: BackupTargetKind): BackupStrategy[] {
  return [...byId.values()].filter((strategy) => strategy.targetKind === kind)
}

/** Stratégie par défaut d'un type de cible (native, jamais le volume pour une DB). */
export function defaultStrategyFor(kind: BackupTargetKind): BackupStrategy | null {
  return strategiesFor(kind)[0] ?? null
}

registerStrategy(postgresStrategy)
registerStrategy(mysqlStrategy)
registerStrategy(mongodbStrategy)
registerStrategy(redisStrategy)
registerStrategy(volumeStrategy)
