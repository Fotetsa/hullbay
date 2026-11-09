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
 * Stratégie MySQL/MariaDB native.
 *
 * `mysqldump --single-transaction` garantit un snapshot cohérent sans verrou
 * global. Le mot de passe est écrit dans un `.my.cnf` en tmpfs (jamais en argv
 * ni dans l'environnement du service).
 */
export class MysqlStrategy implements BackupStrategy {
  readonly id = "mysql.mysqldump"
  readonly targetKind = "mysql" as const
  readonly version = 1

  verifyPrereqs(target: StrategyTarget): PrereqResult {
    if (majorVersion(target.engineVersion) === null) {
      return { ok: false, reason: `version MySQL illisible : ${target.engineVersion}` }
    }
    return { ok: true }
  }

  backup(target: StrategyTarget): StrategyPlan {
    const required = majorVersion(target.engineVersion) ?? 8
    const host = shellQuote(target.host)
    const user = shellQuote(target.username)
    const database = shellQuote(target.database ?? target.username)

    return {
      tool: "mysqldump",
      toolVersion: target.engineVersion,
      payloadFormat: "sql.gz",
      env: {
        SRC_HOST: target.host,
        SRC_PORT: String(target.port),
        SRC_USER: target.username,
        SRC_DB: target.database ?? target.username,
      },
      runtimeFiles: [],
      prereqScript: [
        "set -euo pipefail",
        `required=${required}`,
        "have=$(mysqldump --version | sed -nE 's/.*Ver ([0-9]+)\\..*/\\1/p')",
        'if [ -z "$have" ] || [ "$have" -lt "$required" ]; then',
        '  echo "mysqldump $have < serveur $required" >&2',
        "  exit 3",
        "fi",
      ].join("\n"),
      extractionScript: [
        "set -euo pipefail",
        "umask 077",
        ': "${DB_PASSWORD_FILE:?secret source non monté}"',
        'cat > /tmp/.my.cnf <<EOF',
        "[client]",
        "user=$SRC_USER",
        'password="$(cat "$DB_PASSWORD_FILE")"',
        "host=$SRC_HOST",
        "port=$SRC_PORT",
        "EOF",
        `mysqldump --defaults-extra-file=/tmp/.my.cnf --single-transaction --quick \\`,
        `  --routines --events --databases ${database} | gzip -c -9`,
      ].join("\n"),
      restoreCommand: `gunzip -c payload.sql.gz | mysql --host=${target.host} --port=${target.port} --user=${target.username} --database=${target.database ?? target.username}`,
      requires: { engineMajor: `>=${required}`, clientMajor: `>=${required}` },
    }
  }

  async restore(_artifactId: string, _target: StrategyTarget): Promise<void> {
    throw new NotImplementedError("restore MySQL")
  }
}

export const mysqlStrategy = new MysqlStrategy()
