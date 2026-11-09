import { randomBytes } from "node:crypto"
import type { Readable } from "node:stream"
import type { Placement, Resources } from "@hullbay/shared"
import type { DockerEngineService } from "../../docker-engine/service"
import { SwarmTaskExecutor, type TaskSecret } from "../engine/swarm-task"
import { BackupError } from "../engine/lifecycle"
import { buildRcloneRemoteString, scrubSecrets } from "./remote-string"
import type { ResolvedDestination } from "./registry"
import {
  StorageProviderError,
  UNPROBED_CAPABILITIES,
  type CommitMode,
  type CommitPayloadInput,
  type HashAlgorithm,
  type ObjectStat,
  type PutOptions,
  type PutResult,
  type StagingSink,
  type StorageCapabilities,
  type StorageProvider,
} from "./types"

/**
 * Implémentation `StorageProvider` pour le chemin Swarm (production).
 *
 * C'est l'ADAPTER qui fait le lien entre le contrat de stockage du Backup Engine
 * et rclone : chaque opération durable (put / hash / stat / list / delete /
 * commitPayload) est traduite en un task Swarm one-shot exécutant rclone. Ainsi
 * le moteur ne connaît que `StorageProvider` — rclone reste une implémentation
 * parmi d'autres, exactement comme `RcloneStorageProvider` (Node, local/tests).
 *
 * Le script de commit est le SEUL endroit qui choisit le mécanisme
 * (atomic-rename vs copy-verify-delete) selon les capacités réelles du backend,
 * et il renvoie le mode EXÉCUTÉ — jamais supposé par le moteur.
 */

const RESULT_MODE = "HULLBAY_COMMIT_MODE"

export interface SwarmStorageProviderDeps {
  engine: DockerEngineService
  image: string
  networkName?: string
  placement?: Placement
  resources?: Resources
  timeoutSec: number
  pollMs?: number
  /**
   * Matrice observée par le dernier probe de la destination. Sans probe, les
   * capacités optionnelles valent `false` : le provider ne prétend jamais
   * garantir un checksum ou un rename qu'il n'a pas démontré.
   */
  capabilities?: StorageCapabilities | null
}

export class SwarmStorageProvider implements StorageProvider, StagingSink {
  readonly id = "rclone-swarm"
  private readonly tasks: SwarmTaskExecutor
  private readonly remote: string
  private readonly destination: ResolvedDestination

  constructor(
    private readonly deps: SwarmStorageProviderDeps,
    destination: ResolvedDestination,
  ) {
    this.tasks = new SwarmTaskExecutor(deps.engine)
    this.destination = destination
    this.remote = buildRcloneRemoteString({
      protocol: destination.protocol,
      config: destination.config,
      basePath: destination.basePath,
      secretFiles: {
        privateKey:
          destination.config.protocol === "sftp" ? "/run/secrets/backup_key" : undefined,
        serviceAccountJson:
          destination.config.protocol === "gcs" ? "/run/secrets/backup_key" : undefined,
      },
    })
  }

  capabilities(): StorageCapabilities {
    // Vérité = matrice du dernier probe. Aucune capacité n'est déduite d'un
    // fallback : le commit s'auto-adapte, mais `capabilities()` ne l'annonce pas.
    return this.deps.capabilities ?? UNPROBED_CAPABILITIES
  }

  /**
   * Commande d'upload du staging, fournie par l'adapter (rclone confiné ici).
   * Le runner compose `extraction | <cette commande>` sans connaître rclone.
   */
  stagingUploadScript(key: string): string {
    return `rclone rcat "$REMOTE/${key}"`
  }

  /** Remote-string complète (credentials) montée en secret par le producteur. */
  remoteString(): string {
    return this.remote
  }

  /** Clé privée SFTP / JSON GCS à monter pour le task de transfert. */
  transportSecret(): { material: string; target: string } | null {
    const cfg = this.destination.config
    if (cfg.protocol === "sftp" && cfg.privateKey) {
      return { material: cfg.privateKey, target: "/run/secrets/backup_key" }
    }
    if (cfg.protocol === "gcs") {
      return { material: cfg.serviceAccountJson, target: "/run/secrets/backup_key" }
    }
    return null
  }

  /** Exécute un script rclone dans un task one-shot avec les secrets requis. */
  private async runRclone(
    script: string,
    suffix: string,
    extraSecrets: TaskSecret[] = [],
  ): Promise<string> {
    const runId = `sp_${randomBytes(3).toString("hex")}`
    const remoteSecret = `sp_remote_${runId}`.slice(0, 60)
    const created: string[] = [remoteSecret]
    const secrets: TaskSecret[] = [
      { secretName: remoteSecret, target: "/run/secrets/backup_remote" },
      ...extraSecrets,
    ]

    const cfg = this.destination.config
    const needsKey =
      (cfg.protocol === "sftp" && Boolean(cfg.privateKey)) || cfg.protocol === "gcs"
    if (needsKey) {
      const keySecret = `sp_key_${runId}`.slice(0, 60)
      const material =
        cfg.protocol === "sftp" ? cfg.privateKey! : cfg.protocol === "gcs" ? cfg.serviceAccountJson : ""
      await this.deps.engine.upsertSecret(keySecret, material, {
        "bozando.backupRunId": runId,
      })
      created.push(keySecret)
      secrets.push({ secretName: keySecret, target: "/run/secrets/backup_key" })
    }

    try {
      await this.deps.engine.upsertSecret(remoteSecret, this.remote, {
        "bozando.backupRunId": runId,
      })
      return await this.tasks.run({
        runId,
        suffix,
        script,
        secrets,
        networkName: this.deps.networkName,
        image: this.deps.image,
        placement: this.deps.placement,
        resources: this.deps.resources,
        timeoutSec: this.deps.timeoutSec,
        pollMs: this.deps.pollMs,
      })
    } finally {
      for (const name of created) {
        await this.deps.engine.removeSecret(name).catch(() => undefined)
      }
    }
  }

  /**
   * Écrit un petit objet (manifest, checksum). Un `Readable` est intégralement
   * bufferisé : ce chemin n'est PAS streaming-safe. Le payload de backup passe
   * par `stagingUploadScript()` (StagingSink), jamais par `put()`.
   */
  async put(
    key: string,
    data: Readable | Buffer,
    _opts?: PutOptions,
  ): Promise<PutResult> {
    const buffer = Buffer.isBuffer(data) ? data : await collectStream(data)
    const blobSecret = `sp_blob_${randomBytes(3).toString("hex")}`.slice(0, 60)
    try {
      // Métadonnées texte uniquement (manifest/checksum) : le payload de backup
      // est streamé par le producteur, jamais via `put`.
      await this.deps.engine.upsertSecret(blobSecret, buffer.toString("utf8"), {
        "bozando.backupRunId": `sp_${randomBytes(3).toString("hex")}`,
      })
      await this.runRclone(
        [
          "set -euo pipefail",
          'REMOTE="$(cat /run/secrets/backup_remote)"',
          `rclone rcat "$REMOTE/${key}" < /run/secrets/blob`,
        ].join("\n"),
        "put",
        [{ secretName: blobSecret, target: "/run/secrets/blob" }],
      )
    } finally {
      await this.deps.engine.removeSecret(blobSecret).catch(() => undefined)
    }
    const info = await this.stat(key)
    return { key, size: info?.size ?? buffer.length }
  }

  async get(_key: string): Promise<Readable> {
    // Restore hors périmètre V1 (reviewer #13) : la lecture en streaming d'un
    // artifact depuis un task Swarm n'est pas encore câblée. L'interface reste
    // présente pour ne pas verrouiller le contrat.
    throw new StorageProviderError(
      "lecture en streaming non implémentée pour le backend Swarm (restore hors périmètre V1)",
      "not_implemented",
    )
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const result = await this.runRclone(
      [
        "set -euo pipefail",
        'REMOTE="$(cat /run/secrets/backup_remote)"',
        `rclone lsjson --stat "$REMOTE/${key}"`,
      ].join("\n"),
      "stat",
    )
    const line = result.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"))
    if (!line) return null
    try {
      const parsed = JSON.parse(line) as { Size?: number; ModTime?: string; IsDir?: boolean }
      if (parsed.IsDir) return null
      return { key, size: parsed.Size ?? 0, modifiedAt: parsed.ModTime }
    } catch {
      return null
    }
  }

  async list(prefix: string): Promise<ObjectStat[]> {
    const safePrefix = prefix.replace(/^\/+|\/+$/g, "")
    const result = await this.runRclone(
      [
        "set -euo pipefail",
        'REMOTE="$(cat /run/secrets/backup_remote)"',
        `rclone lsjson -R "$REMOTE/${safePrefix}"`,
      ].join("\n"),
      "list",
    )
    try {
      const parsed = JSON.parse(result || "[]") as {
        Path?: string
        Name?: string
        Size?: number
        ModTime?: string
        IsDir?: boolean
      }[]
      return parsed
        .filter((entry) => !entry.IsDir)
        .map((entry) => {
          const relative = entry.Path ?? entry.Name ?? ""
          // `rclone lsjson -R` renvoie des chemins RELATIFS au préfixe listé.
          // Le contrat exige des clés complètes, directement acceptées par
          // delete()/get()/stat() — sinon le nettoyage supprime au mauvais endroit.
          const key = safePrefix ? `${safePrefix}/${relative}` : relative
          return {
            key: key.replace(/\/+$/, ""),
            size: entry.Size ?? 0,
            modifiedAt: entry.ModTime,
          }
        })
    } catch {
      throw new StorageProviderError(scrubSecrets("list impossible"), "list_failed")
    }
  }

  async delete(key: string): Promise<void> {
    await this.runRclone(
      [
        "set -euo pipefail",
        'REMOTE="$(cat /run/secrets/backup_remote)"',
        `rclone deletefile "$REMOTE/${key}"`,
      ].join("\n"),
      "delete",
    )
  }

  async move(from: string, to: string): Promise<boolean> {
    const unsupported = /not support|unsupported|operation not permitted/i
    try {
      const result = await this.runRclone(
        [
          "set -euo pipefail",
          'REMOTE="$(cat /run/secrets/backup_remote)"',
          `rclone moveto "$REMOTE/${from}" "$REMOTE/${to}" 2>&1`,
        ].join("\n"),
        "move",
      )
      return !unsupported.test(result)
    } catch (error) {
      const logs = error instanceof BackupError ? error.logs ?? "" : ""
      const msg = error instanceof Error ? error.message : String(error)
      if (unsupported.test(`${msg} ${logs}`)) return false
      throw error
    }
  }

  async hash(key: string, algorithm: HashAlgorithm = "sha256"): Promise<string | null> {
    const result = await this.runRclone(
      [
        "set -euo pipefail",
        'REMOTE="$(cat /run/secrets/backup_remote)"',
        `rclone hashsum ${algorithm} "$REMOTE/${key}"`,
      ].join("\n"),
      "hash",
    )
    const value = result.trim().split(/\s+/)[0] ?? ""
    return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null
  }

  async commitPayload(input: CommitPayloadInput): Promise<CommitMode> {
    const { stagingKey, finalKey, expectedChecksum, expectedSizeBytes } = input
    const script = [
      "set -euo pipefail",
      'REMOTE="$(cat /run/secrets/backup_remote)"',
      `SRC="$REMOTE/${stagingKey}"`,
      `DST="$REMOTE/${finalKey}"`,
      `EXPECTED="${expectedChecksum}"`,
      `EXPECTED_SIZE="${expectedSizeBytes}"`,
      // La taille est TOUJOURS vérifiée : elle reste la référence quand le
      // backend n'expose pas de checksum natif.
      `SIZE="$(rclone lsjson --stat "$SRC" 2>/dev/null | tr -d ' ' | grep -o '"Size":[0-9]*' | cut -d: -f2)" || SIZE=""`,
      'if [ -z "$SIZE" ]; then',
      '  echo "taille distante illisible" >&2',
      "  exit 7",
      "fi",
      'if [ "$SIZE" != "$EXPECTED_SIZE" ]; then',
      '  echo "taille distante differente" >&2',
      "  exit 8",
      "fi",
      // Checksum seulement si le backend le fournit ; sinon la taille (déjà
      // validée) fait foi, conformément au downgrade du lifecycle.
      'HAVE="$(rclone hashsum sha256 "$SRC" 2>/dev/null | awk \'{print $1}\')" || HAVE=""',
      'if [ -n "$HAVE" ] && [ "$HAVE" != "$EXPECTED" ]; then',
      '  echo "checksum distant different" >&2',
      "  exit 4",
      "fi",
      'MODE="atomic-rename"',
      'MOVE_ERR=""',
      'if MOVE_ERR="$(rclone moveto "$SRC" "$DST" 2>&1)"; then',
      "  :",
      "else",
      "  if printf '%s' \"$MOVE_ERR\" | grep -qiE \"not support|unsupported|operation not permitted\"; then",
      '    MODE="copy-verify-delete"',
      '    rclone copyto "$SRC" "$DST"',
      // Même contrat en fallback : checksum si disponible, sinon taille.
      '    NEW="$(rclone hashsum sha256 "$DST" 2>/dev/null | awk \'{print $1}\')" || NEW=""',
      '    if [ -n "$NEW" ]; then',
      '      if [ "$NEW" != "$EXPECTED" ]; then',
      '        echo "copie distante non verifiee" >&2',
      "        exit 5",
      "      fi",
      "    else",
      `      NEW_SIZE="$(rclone lsjson --stat "$DST" 2>/dev/null | tr -d ' ' | grep -o '"Size":[0-9]*' | cut -d: -f2)" || NEW_SIZE=""`,
      '      if [ -z "$NEW_SIZE" ] || [ "$NEW_SIZE" != "$EXPECTED_SIZE" ]; then',
      '        echo "copie distante non verifiee (taille)" >&2',
      "        exit 5",
      "      fi",
      "    fi",
      '    rclone deletefile "$SRC"',
      "  else",
      '    echo "moveto echoue" >&2',
      '    printf \'%s\\n\' "$MOVE_ERR" >&2',
      "    exit 6",
      "  fi",
      "fi",
      `echo "${RESULT_MODE} $MODE"`,
    ].join("\n")

    let logs = ""
    try {
      logs = await this.runRclone(script, "commit")
    } catch (error) {
      const logsOfError =
        error instanceof BackupError ? scrubSecrets(error.logs ?? "") : ""
      const msg = scrubSecrets(error instanceof Error ? error.message : String(error))
      const combined = `${msg} ${logsOfError}`
      if (/checksum distant different/i.test(combined)) {
        throw new StorageProviderError("checksum distant différent", "checksum_mismatch")
      }
      if (/taille distante/i.test(combined)) {
        throw new StorageProviderError("taille distante différente", "verify_failed")
      }
      if (/copie distante non verifiee/i.test(combined)) {
        throw new StorageProviderError("copie distante non vérifiée", "commit_failed")
      }
      throw new StorageProviderError(msg || "commit échoué", "commit_failed")
    }
    const line = logs.split(/\r?\n/).reverse().find((l) => l.includes(RESULT_MODE))
    const mode = line?.trim().split(/\s+/)[1]
    if (mode === "copy-verify-delete") return "copy-verify-delete"
    return "atomic-rename"
  }
}

async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
