import type { DockerEngineService } from "../../docker-engine/service"
import { SwarmTaskExecutor, type TaskSecret } from "../engine/swarm-task"
import { buildRcloneRemoteString } from "./remote-string"
import type { ResolvedDestination } from "./registry"

/**
 * Probe de capacité d'une destination (reviewer #11), exécuté dans un task
 * Swarm one-shot. Séquence : auth → read → write → checksum → move → delete.
 *
 * Ce diagnostic vit dans la couche stockage (il parle rclone) et non dans le
 * runner : le Backup Engine reste neutre vis-à-vis du backend.
 */

function secretName(prefix: string, runId: string): string {
  return `${prefix}_${runId}`.slice(0, 60)
}

export async function probeDestination(input: {
  engine: DockerEngineService
  image: string
  destination: ResolvedDestination
  timeoutSec?: number
}): Promise<{ ok: boolean; capabilities: Record<string, boolean>; logs: string }> {
  const executor = new SwarmTaskExecutor(input.engine)
  const runId = `probe${Date.now().toString(36)}`
  const remoteSecret = secretName("backup_probe", runId)
  const created: string[] = [remoteSecret]
  const probeKey = `.probe/${runId}`
  const script = [
    "set -euo pipefail",
    'REMOTE="$(cat /run/secrets/backup_remote)"',
    "READ=false; WRITE=false; DELETE=false; CHECKSUM=false; MOVE=false",
    'if rclone lsd "$REMOTE" >/dev/null 2>&1; then READ=true; fi',
    `if printf 'probe' | rclone rcat "$REMOTE/${probeKey}" >/dev/null 2>&1; then WRITE=true; fi`,
    'if [ "$WRITE" = true ]; then',
    `  if rclone hashsum sha256 "$REMOTE/${probeKey}" 2>/dev/null | grep -Eq '^[0-9a-f]{64}'; then CHECKSUM=true; fi`,
    `  if rclone moveto "$REMOTE/${probeKey}" "$REMOTE/${probeKey}.moved" >/dev/null 2>&1; then MOVE=true; fi`,
    `  if rclone deletefile "$REMOTE/${probeKey}" >/dev/null 2>&1; then DELETE=true; fi`,
    `  rclone deletefile "$REMOTE/${probeKey}.moved" >/dev/null 2>&1 || true`,
    "fi",
    'printf "HULLBAY_PROBE read=%s write=%s delete=%s checksum=%s move=%s\\n" "$READ" "$WRITE" "$DELETE" "$CHECKSUM" "$MOVE"',
  ].join("\n")

  try {
    const cfg = input.destination.config
    const needsKey =
      (cfg.protocol === "sftp" && Boolean(cfg.privateKey)) || cfg.protocol === "gcs"
    const secrets: TaskSecret[] = [
      { secretName: remoteSecret, target: "/run/secrets/backup_remote" },
    ]
    if (needsKey) {
      const keySecret = secretName("backup_probe_key", runId)
      const material =
        cfg.protocol === "sftp" ? cfg.privateKey! : cfg.protocol === "gcs" ? cfg.serviceAccountJson : ""
      await input.engine.upsertSecret(keySecret, material, {
        "bozando.backupRunId": runId,
      })
      created.push(keySecret)
      secrets.push({ secretName: keySecret, target: "/run/secrets/backup_key" })
    }

    await input.engine.upsertSecret(
      remoteSecret,
      buildRcloneRemoteString({
        protocol: input.destination.protocol,
        config: input.destination.config,
        basePath: input.destination.basePath,
        secretFiles: {
          privateKey: needsKey ? "/run/secrets/backup_key" : undefined,
          serviceAccountJson: needsKey ? "/run/secrets/backup_key" : undefined,
        },
      }),
      { "bozando.backupRunId": runId },
    )
    const logs = await executor.run({
      runId,
      suffix: "probe",
      script,
      secrets,
      image: input.image,
      timeoutSec: input.timeoutSec ?? 60,
    })
    const line = logs.split(/\r?\n/).reverse().find((l) => l.includes("HULLBAY_PROBE"))
    const caps = { read: false, write: false, delete: false, checksum: false, move: false }
    if (line) {
      for (const pair of line.trim().split(/\s+/).slice(1)) {
        const [key, value] = pair.split("=")
        if (key && key in caps) caps[key as keyof typeof caps] = value === "true"
      }
    }
    return {
      ok: caps.read && caps.write && caps.delete,
      capabilities: {
        ...caps,
        atomicCommit: caps.move,
        serverSideEncryption: false,
      },
      logs,
    }
  } finally {
    for (const name of created) {
      await input.engine.removeSecret(name).catch(() => undefined)
    }
  }
}
