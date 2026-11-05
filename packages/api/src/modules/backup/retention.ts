import type { DockerEngineService } from "../docker-engine/service"
import { SwarmTaskExecutor, type TaskSecret } from "./engine/swarm-task"
import { buildRcloneRemoteString } from "./storage/remote-string"
import type { ResolvedDestination } from "./storage/registry"
import { scrubSecrets } from "./storage/remote-string"

/**
 * Rétention : `rclone delete --min-age <N>d` strictement sous le préfixe de la
 * cible. Jamais exécutée sur un run échoué (l'appelant ne l'invoque qu'après
 * commit). Dry-run par défaut : une suppression ne s'active qu'explicitement.
 */

export interface RetentionScope {
  basePath: string
  projectSlug: string
  targetName: string
  retentionDays: number
  dryRun?: boolean
}

/** Refuse un préfixe vide ou racine — garde-fou contre une suppression globale. */
export function assertSafeScope(scope: RetentionScope): string {
  const prefix = [scope.basePath, scope.projectSlug, scope.targetName]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter((part) => part.length > 0)
    .join("/")

  if (prefix.length === 0 || prefix === "/" || /(^|\/)\.\.?(\/|$)/.test(prefix)) {
    throw new Error("préfixe de rétention invalide")
  }
  if (!Number.isInteger(scope.retentionDays) || scope.retentionDays < 1) {
    throw new Error("rétention invalide : nombre de jours >= 1 requis")
  }
  return prefix
}

export function buildRetentionScript(
  prefix: string,
  retentionDays: number,
  dryRun: boolean,
): string {
  return [
    "set -euo pipefail",
    'REMOTE="$(cat /run/secrets/backup_remote)"',
    `TARGET="$REMOTE/${prefix}"`,
    'case "$TARGET" in ""|*/) echo "préfixe de rétention invalide" >&2; exit 5;; esac',
    `rclone delete "$TARGET" --min-age ${retentionDays}d${dryRun ? " --dry-run" : ""}`,
    'echo "HULLBAY_RETENTION done"',
  ].join("\n")
}

export interface RetentionResult {
  ok: boolean
  dryRun: boolean
  error?: string
}

export async function runRetention(input: {
  engine: DockerEngineService
  image: string
  destination: ResolvedDestination
  scope: RetentionScope
  timeoutSec?: number
}): Promise<RetentionResult> {
  const dryRun = input.scope.dryRun ?? process.env.BACKUP_RETENTION_DRY_RUN !== "false"
  const prefix = assertSafeScope(input.scope)
  const executor = new SwarmTaskExecutor(input.engine)
  const runId = `retention${Date.now().toString(36)}`
  const remoteSecret = `backup_retention_${runId}`.slice(0, 60)
  const created = [remoteSecret]

  try {
    const needsKey =
      (input.destination.config.protocol === "sftp" &&
        Boolean(input.destination.config.privateKey)) ||
      input.destination.config.protocol === "gcs"
    let keySecret: string | undefined
    if (needsKey) {
      keySecret = `backup_retention_key_${runId}`.slice(0, 60)
      const material =
        input.destination.config.protocol === "sftp"
          ? input.destination.config.privateKey!
          : input.destination.config.protocol === "gcs"
            ? input.destination.config.serviceAccountJson
            : ""
      await input.engine.upsertSecret(keySecret, material, {
        "bozando.backupRunId": runId,
      })
      created.push(keySecret)
    }

    await input.engine.upsertSecret(
      remoteSecret,
      buildRcloneRemoteString({
        protocol: input.destination.protocol,
        config: input.destination.config,
        basePath: input.destination.basePath,
        secretFiles: {
          privateKey:
            input.destination.config.protocol === "sftp"
              ? "/run/secrets/backup_key"
              : undefined,
          serviceAccountJson:
            input.destination.config.protocol === "gcs"
              ? "/run/secrets/backup_key"
              : undefined,
        },
      }),
      { "bozando.backupRunId": runId },
    )
    const secrets: TaskSecret[] = [
      { secretName: remoteSecret, target: "/run/secrets/backup_remote" },
      ...(keySecret
        ? [{ secretName: keySecret, target: "/run/secrets/backup_key" }]
        : []),
    ]
    await executor.run({
      runId,
      suffix: "retention",
      script: buildRetentionScript(prefix, input.scope.retentionDays, dryRun),
      secrets,
      image: input.image,
      timeoutSec: input.timeoutSec ?? 300,
    })
    return { ok: true, dryRun }
  } catch (error) {
    return {
      ok: false,
      dryRun,
      error: scrubSecrets(error instanceof Error ? error.message : String(error)),
    }
  } finally {
    for (const name of created) {
      await input.engine.removeSecret(name).catch(() => undefined)
    }
  }
}
