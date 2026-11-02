import type { BackupDestinationFields, BackupProtocol } from "@hullbay/shared"
import { RcloneStorageProvider } from "./rclone-provider"
import { buildRcloneRemoteString } from "./remote-string"
import type { StorageCapabilities, StorageProvider } from "./types"

/**
 * Registry des backends de stockage. Ajouter un backend = enregistrer une
 * factory ici (ou dans un module voisin) — le Backup Engine n'est pas modifié.
 */

export interface ResolvedDestination {
  protocol: BackupProtocol
  config: BackupDestinationFields
  basePath: string
  /** Matrice issue du dernier probe ; `null` = destination jamais sondée. */
  capabilities?: StorageCapabilities | null
  /** Secrets matérialisés en fichier (tmpfs du task) pour SFTP/GCS. */
  secretFiles?: { privateKey?: string; serviceAccountJson?: string }
}

export type StorageProviderFactory = (destination: ResolvedDestination) => StorageProvider

const factories = new Map<BackupProtocol, StorageProviderFactory>()

export function registerStorageProvider(
  protocol: BackupProtocol,
  factory: StorageProviderFactory,
): void {
  factories.set(protocol, factory)
}

export function createStorageProvider(destination: ResolvedDestination): StorageProvider {
  const factory = factories.get(destination.protocol)
  if (!factory) {
    throw new Error(`aucun backend de stockage pour le protocole ${destination.protocol}`)
  }
  return factory(destination)
}

/** Backend rclone pour les six protocoles V1 (un seul code, six configurations). */
function rcloneFactory(destination: ResolvedDestination): StorageProvider {
  const remote = buildRcloneRemoteString({
    protocol: destination.protocol,
    config: destination.config,
    basePath: destination.basePath,
    secretFiles: destination.secretFiles,
  })
  return new RcloneStorageProvider(remote, {
    capabilities: destination.capabilities ?? null,
  })
}

for (const protocol of ["s3", "sftp", "webdav", "smb", "gcs", "azureblob"] as const) {
  registerStorageProvider(protocol, rcloneFactory)
}
