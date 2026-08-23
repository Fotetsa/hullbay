import type { DatabaseEngine, DatabaseProvider } from "../types.js"
import { postgresProvider } from "./postgres.js"
import { mysqlProvider } from "./mysql.js"
import { mongoProvider } from "./mongodb.js"
import { redisProvider } from "./redis.js"

/**
 * Registry des providers — un par moteur.
 */
export const DATABASE_PROVIDERS: Partial<Record<DatabaseEngine, DatabaseProvider>> = {
  postgres: postgresProvider,
  mysql: mysqlProvider,
  mongodb: mongoProvider,
  redis: redisProvider,
}

/** Provider d'un moteur */
export function getDatabaseProvider(engine: DatabaseEngine): DatabaseProvider | null {
  return DATABASE_PROVIDERS[engine] ?? null
}