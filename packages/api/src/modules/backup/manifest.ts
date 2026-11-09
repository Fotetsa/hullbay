import {
  BACKUP_FORMAT_VERSION,
  BackupManifestSchema,
  parseBackupManifest,
  type BackupManifest,
  type BackupTargetKind,
} from "@hullbay/shared"

/**
 * Manifest d'artifact — contrat de format du Backup Engine.
 *
 * Règle de commit : le manifest est écrit EN DERNIER sur le stockage distant.
 * Sa présence à la clé finale vaut commit ; un payload sans manifest est un
 * staging orphelin, jamais un artifact restaurable.
 */

export interface ManifestTarget {
  nodeId: string
  name: string
  kind: BackupTargetKind
}

export interface ManifestSource {
  engine: string
  engineVersion: string
  database?: string
}

export interface BuildManifestInput {
  artifactId: string
  runId: string
  target: ManifestTarget
  source: ManifestSource
  strategy: { id: string; version: number; tool: string; toolVersion: string }
  payload: { path: string; format: string; sizeBytes: number }
  checksumSha256: string
  encryptionMode: "none"
  verificationMode: "size" | "checksum"
  verificationDowngraded: boolean
  commitMode: "atomic-rename" | "copy-verify-delete"
  restore: { strategyId: string; command: string; requires?: Record<string, string> }
  createdAt?: Date
}

export function buildManifest(input: BuildManifestInput): BackupManifest {
  return BackupManifestSchema.parse({
    formatVersion: BACKUP_FORMAT_VERSION,
    artifactId: input.artifactId,
    runId: input.runId,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    target: input.target,
    source: input.source,
    strategy: input.strategy,
    payload: input.payload,
    checksum: { algorithm: "sha256", value: input.checksumSha256 },
    encryption: { mode: input.encryptionMode },
    verification: { mode: input.verificationMode, downgraded: input.verificationDowngraded },
    commit: { mode: input.commitMode },
    restore: {
      strategyId: input.restore.strategyId,
      command: input.restore.command,
      requires: input.restore.requires ?? {},
    },
  })
}

export { parseBackupManifest }

/** Nom de dossier sûr pour un target (pas de `/`, pas de `..`). */
export function safeSegment(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.{2,}/g, ".")
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "target"
  return cleaned.slice(0, 80)
}

/** Préfixe distant d'un artifact : `<basePath>/<projet>/<cible>/<artifactId>`. */
export function artifactPrefix(
  basePath: string,
  projectSlug: string,
  targetName: string,
  artifactId: string,
): string {
  return [
    basePath.replace(/^\/+|\/+$/g, ""),
    safeSegment(projectSlug),
    safeSegment(targetName),
    safeSegment(artifactId),
  ]
    .filter((part) => part.length > 0)
    .join("/")
}

export const MANIFEST_FILE = "manifest.json"
export const CHECKSUM_FILE = "payload.sha256"
