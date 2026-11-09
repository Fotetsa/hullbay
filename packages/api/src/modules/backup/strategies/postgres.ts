import {
  NotImplementedError,
  majorVersion,
  shellQuote,
  type BackupStrategy,
  type PrereqResult,
  type StrategyPlan,
  type StrategyTarget,
} from "./types"

/**
 * Stratégie PostgreSQL native.
 *
 * `pg_dump --format=plain` + gzip : format universel, restaurable avec
 * `gunzip | psql` sans Hullbay. Le mot de passe n'est jamais dans la commande :
 * le runner monte un `.pgpass` en tmpfs et exporte `PGPASSFILE`.
 */
export class PostgresStrategy implements BackupStrategy {
  readonly id = "postgres.pg_dump"
  readonly targetKind = "postgres" as const
  readonly version = 1

  verifyPrereqs(target: StrategyTarget): PrereqResult {
    const required = majorVersion(target.engineVersion)
    if (required === null) {
      return { ok: false, reason: `version PostgreSQL illisible : ${target.engineVersion}` }
    }
    return { ok: true }
  }

  backup(target: StrategyTarget): StrategyPlan {
    const required = majorVersion(target.engineVersion)
    if (required === null) {
      throw new Error(`version PostgreSQL illisible : ${target.engineVersion}`)
    }

    const host = shellQuote(target.host)
    const port = String(target.port)
    const user = shellQuote(target.username)
    const database = shellQuote(target.database ?? target.username)

    const env = {
      SRC_HOST: target.host,
      SRC_PORT: port,
      SRC_USER: target.username,
      SRC_DB: target.database ?? target.username,
    }

    return {
      tool: "pg_dump",
      toolVersion: target.engineVersion,
      payloadFormat: "sql.gz",
      env,
      // Aucun fichier pré-rempli : le .pgpass est construit DANS le task depuis
      // le secret monté. L'API ne lit jamais le mot de passe.
      runtimeFiles: [],
      prereqScript: [
        "set -euo pipefail",
        `required=${required}`,
        "have=$(pg_dump --version | sed -E 's/.* ([0-9]+)(\\.[0-9]+)?.*/\\1/')",
        'if [ -z "$have" ] || [ "$have" -lt "$required" ]; then',
        '  echo "pg_dump $have < serveur $required" >&2',
        "  exit 3",
        "fi",
      ].join("\n"),
      extractionScript: [
        "set -euo pipefail",
        'umask 077',
        ': "${DB_PASSWORD_FILE:?secret source non monté}"',
        `printf '%s:%s:%s:%s:%s\\n' "$SRC_HOST" "$SRC_PORT" "$SRC_DB" "$SRC_USER" \\`,
        '  "$(cat "$DB_PASSWORD_FILE")" > /tmp/.pgpass',
        "export PGPASSFILE=/tmp/.pgpass",
        `pg_dump --no-owner --no-privileges --format=plain \\`,
        `  --host=${host} --port=${port} --username=${user} --dbname=${database} \\`,
        "  | gzip -c -9",
      ].join("\n"),
      restoreCommand: `gunzip -c payload.sql.gz | psql --host=${target.host} --port=${port} --username=${target.username} --dbname=${target.database ?? target.username}`,
      requires: { engineMajor: `>=${required}`, clientMajor: `>=${required}` },
    }
  }

  async restore(_artifactId: string, _target: StrategyTarget): Promise<void> {
    throw new NotImplementedError("restore PostgreSQL")
  }
}

export const postgresStrategy = new PostgresStrategy()
