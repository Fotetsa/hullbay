import type { BackupTargetKind } from "@hullbay/shared"

/**
 * Contrat de stratégie de sauvegarde.
 *
 * `backup()` produit un plan exécutable par le runner (extraction streamée vers
 * stdout) ; `restore()` est déclaré dès maintenant pour que le format produit
 * reste restaurable, même si l'implémentation est livrée après le MVP.
 */

export interface StrategyTarget {
  nodeId: string
  name: string
  kind: BackupTargetKind
  /** Moteur logique (postgres, mysql, mongodb, redis, volume). */
  engine: string
  engineVersion: string
  host: string
  port: number
  database?: string
  username: string
  /** Référence de Docker Secret — jamais la valeur. */
  passwordSecretRef?: string
  volumeName?: string
  mountPath?: string
  /** Volume marqué `bozando.database.data=true` : données d'une base vivante. */
  isDataVolume?: boolean
  /**
   * Override opérateur explicite (`BACKUP_ALLOW_DATABASE_VOLUME=true`).
   * Sans lui, un volume de données de base est refusé : un tar d'un datadir
   * vivant n'est pas une sauvegarde cohérente.
   */
  allowDataVolume?: boolean
}

export interface StrategyPlan {
  tool: string
  toolVersion: string
  /** Format du payload produit (`sql.gz`, `archive.gz`, `rdb.gz`, `tar.gz`). */
  payloadFormat: string
  /** Script qui écrit le payload sur stdout (pipe direct vers le stockage). */
  extractionScript: string
  /** Script de prérequis : sortie non nulle = backup refusé avant transfert. */
  prereqScript?: string
  /** Commande de restauration documentée dans le manifest (outils standards). */
  restoreCommand: string
  requires: Record<string, string>
  /** Fichiers non secrets à créer dans le tmpfs du task (ex. .pgpass vide). */
  runtimeFiles?: { path: string; content: string; mode?: number }[]
  /** Variables d'environnement non sensibles. */
  env?: Record<string, string>
}

export interface PrereqResult {
  ok: boolean
  reason?: string
}

export class NotImplementedError extends Error {
  readonly code = "not_implemented"
  constructor(what: string) {
    super(`${what} n'est pas implémenté dans cette version`)
    this.name = "NotImplementedError"
  }
}

/**
 * Contrat de restauration. Déclaré en V1 mais non implémenté : un artifact
 * auto-descriptif (manifest + checksum) reste restaurable manuellement avec
 * les outils standards documentés.
 */
export interface RestoreStrategy {
  restore(artifactId: string, target: StrategyTarget): Promise<void>
}

export interface BackupStrategy extends RestoreStrategy {
  readonly id: string
  readonly targetKind: BackupTargetKind
  readonly version: number
  backup(target: StrategyTarget): StrategyPlan
  verifyPrereqs(target: StrategyTarget): PrereqResult
}

/** Extrait la majeure d'une version (`16`, `16.3`, `v16-alpine` → `16`). */
export function majorVersion(version: string): number | null {
  const match = /(\d+)/.exec(version)
  if (!match) return null
  const major = Number.parseInt(match[1]!, 10)
  return Number.isFinite(major) ? major : null
}

/** Échappe une valeur destinée à un script shell (jamais un secret). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
