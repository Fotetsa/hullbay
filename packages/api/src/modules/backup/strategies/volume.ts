import {
  NotImplementedError,
  type BackupStrategy,
  type PrereqResult,
  type StrategyPlan,
  type StrategyTarget,
} from "./types"

/**
 * Stratégie volume générique.
 *
 * Un volume n'est PAS une base : cette stratégie est le fallback pour des
 * données non structurées. Le runner monte le volume en lecture seule sur
 * `/data` — jamais de tar d'un datadir de base vivante (refusé côté policy).
 */
export class VolumeStrategy implements BackupStrategy {
  readonly id = "volume.tar"
  readonly targetKind = "volume" as const
  readonly version = 1

  verifyPrereqs(_target: StrategyTarget): PrereqResult {
    return { ok: true }
  }

  backup(target: StrategyTarget): StrategyPlan {
    if (target.isDataVolume && !target.allowDataVolume) {
      throw new Error(
        "volume de données de base refusé : un tar d'un datadir vivant n'est pas une sauvegarde cohérente (utiliser la stratégie du moteur)",
      )
    }
    const mountPath = target.mountPath ?? "/data"
    return {
      tool: "tar",
      toolVersion: "1",
      payloadFormat: "tar.gz",
      env: {},
      runtimeFiles: [],
      prereqScript: [
        "set -euo pipefail",
        `if [ ! -d "${mountPath}" ]; then echo "volume non monté sur ${mountPath}" >&2; exit 3; fi`,
      ].join("\n"),
      extractionScript: [
        "set -euo pipefail",
        `tar -C "${mountPath}" -czf - .`,
      ].join("\n"),
      restoreCommand: `tar -xzf payload.tar.gz -C ${mountPath}`,
      requires: {},
    }
  }

  async restore(_artifactId: string, _target: StrategyTarget): Promise<void> {
    throw new NotImplementedError("restore volume")
  }
}

export const volumeStrategy = new VolumeStrategy()
