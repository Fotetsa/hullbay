import {
  NotImplementedError,
  type BackupStrategy,
  type PrereqResult,
  type StrategyPlan,
  type StrategyTarget,
} from "./types"

/**
 * Stratégie Redis.
 *
 * `redis-cli --rdb -` demande un snapshot RDB et l'écrit sur stdout : aucun
 * BGSAVE sur le disque du nœud, aucun fichier temporaire. Le mot de passe passe
 * par `REDISCLI_AUTH` (variable du process dans le task), jamais en argument.
 */
export class RedisStrategy implements BackupStrategy {
  readonly id = "redis.rdb"
  readonly targetKind = "redis" as const
  readonly version = 1

  verifyPrereqs(_target: StrategyTarget): PrereqResult {
    return { ok: true }
  }

  backup(target: StrategyTarget): StrategyPlan {
    return {
      tool: "redis-cli",
      toolVersion: target.engineVersion,
      payloadFormat: "rdb.gz",
      env: {
        SRC_HOST: target.host,
        SRC_PORT: String(target.port),
      },
      runtimeFiles: [],
      extractionScript: [
        "set -euo pipefail",
        ': "${DB_PASSWORD_FILE:?secret source non monté}"',
        'export REDISCLI_AUTH="$(cat "$DB_PASSWORD_FILE")"',
        'redis-cli --no-auth-warning -h "$SRC_HOST" -p "$SRC_PORT" --rdb - | gzip -c -9',
      ].join("\n"),
      restoreCommand:
        "gunzip -c payload.rdb.gz > dump.rdb, puis démarrer Redis avec ce fichier (ou redis-cli --pipe selon le mode)",
      requires: {},
    }
  }

  async restore(_artifactId: string, _target: StrategyTarget): Promise<void> {
    throw new NotImplementedError("restore Redis")
  }
}

export const redisStrategy = new RedisStrategy()
