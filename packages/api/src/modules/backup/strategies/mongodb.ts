import {
  NotImplementedError,
  majorVersion,
  type BackupStrategy,
  type PrereqResult,
  type StrategyPlan,
  type StrategyTarget,
} from "./types"

/**
 * Stratégie MongoDB native.
 *
 * `mongodump --archive --gzip` streame l'archive complète. L'URI (donc le mot
 * de passe) est écrite dans un fichier YAML en tmpfs, jamais en argv.
 */
export class MongodbStrategy implements BackupStrategy {
  readonly id = "mongodb.mongodump"
  readonly targetKind = "mongodb" as const
  readonly version = 1

  verifyPrereqs(target: StrategyTarget): PrereqResult {
    if (majorVersion(target.engineVersion) === null) {
      return { ok: false, reason: `version MongoDB illisible : ${target.engineVersion}` }
    }
    return { ok: true }
  }

  backup(target: StrategyTarget): StrategyPlan {
    const database = target.database ?? "admin"

    return {
      tool: "mongodump",
      toolVersion: target.engineVersion,
      payloadFormat: "archive.gz",
      env: {
        SRC_HOST: target.host,
        SRC_PORT: String(target.port),
        SRC_USER: target.username,
        SRC_DB: database,
      },
      runtimeFiles: [],
      // Les Database Tools ont leur propre cycle de version (100.x) : comparer
      // leur majeure à celle du serveur n'a aucun sens. On vérifie seulement la
      // présence du binaire ; l'incompatibilité réelle est signalée par l'outil.
      prereqScript: [
        "set -euo pipefail",
        'command -v mongodump >/dev/null || { echo "mongodump absent de l\'image" >&2; exit 3; }',
      ].join("\n"),
      extractionScript: [
        "set -euo pipefail",
        "umask 077",
        ': "${DB_PASSWORD_FILE:?secret source non monté}"',
        'PASS="$(cat "$DB_PASSWORD_FILE")"',
        'ESC="$(printf \'%s\' "$PASS" | sed \'s/\\\\/\\\\\\\\/g; s/"/\\\\"/g\')"',
        "cat > /tmp/mongodump.yaml <<EOF",
        'uri: "mongodb://$SRC_USER:$ESC@$SRC_HOST:$SRC_PORT/$SRC_DB?authSource=admin"',
        "EOF",
        "mongodump --config /tmp/mongodump.yaml --archive --gzip",
      ].join("\n"),
      // L'archive est DÉJÀ gzip (`--gzip`) : ne pas la décompresser avant
      // mongorestore, qui attend une archive gzip avec `--gzip`.
      restoreCommand: `mongorestore --archive --gzip --uri "mongodb://<user>:<password>@${target.host}:${target.port}/${database}" < payload.archive.gz`,
      requires: {},
    }
  }

  async restore(_artifactId: string, _target: StrategyTarget): Promise<void> {
    throw new NotImplementedError("restore MongoDB")
  }
}

export const mongodbStrategy = new MongodbStrategy()
