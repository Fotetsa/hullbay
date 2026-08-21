import { DatabaseConfigSchema } from "@hullbay/shared"
import type { DatabaseConfig } from "@hullbay/shared"
import { z } from "zod"
import { validateTopology } from "./topology.js"

export class DatabaseValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuration de base de données invalide : ${issues.join(" ; ")}`)
    this.name = "DatabaseValidationError"
  }
}

/**
 * Valide une configuration database : d'abord le schéma partagé (Zod), puis les
 * règles de topologie du moteur. Lève en cas d'erreur — jamais de mutation
 * silencieuse (une topologie invalide doit bloquer AVANT la réconciliation).
 */
export function validateDatabaseConfig(raw: unknown): DatabaseConfig {
  let config: DatabaseConfig
  try {
    config = DatabaseConfigSchema.parse(raw)
  } catch (err) {
    // ZodError → DatabaseValidationError pour une route 422/DeployError propre.
    const issues =
      err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : [String(err)]
    throw new DatabaseValidationError(issues)
  }
  const issues = validateTopology(config)
  if (issues.length > 0) {
    throw new DatabaseValidationError(issues)
  }
  return config
}
