import type { Readable } from "node:stream"

/**
 * Contrat de stockage du Backup Engine.
 *
 * Le cœur du moteur ne connaît que cette interface : Rclone est une
 * implémentation parmi d'autres (un backend local suffit à le prouver).
 * Les divergences entre backends (rename atomique, checksum natif) sont
 * exposées explicitement par `capabilities()` — jamais supposées.
 */

/**
 * Erreur d'un backend de stockage, porteuse d'un code métier stable
 * (`checksum_mismatch`, `commit_failed`, `destination_unreachable`, …).
 * Le Backup Engine s'appuie sur `code`, jamais sur le message brut.
 */
export class StorageProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "StorageProviderError"
  }
}

/**
 * Ce que le backend garantit RÉELLEMENT — jamais ce que Hullbay sait émuler.
 *
 * Une capacité vaut `true` seulement si elle a été observée (probe) ou si le
 * backend la garantit par construction (système de fichiers local). Les
 * fallbacks (copy-verify-delete, vérification par taille) restent de la logique
 * du provider et ne doivent pas être annoncés ici : un backend sans checksum
 * natif expose `checksum: false`, même si Hullbay sait le contourner.
 */
export interface StorageCapabilities {
  read: boolean
  write: boolean
  delete: boolean
  move: boolean
  checksum: boolean
  atomicCommit: boolean
  serverSideEncryption: boolean
}

/**
 * Capacités d'un backend jamais sondé : aucune garantie n'a été observée.
 * Utilisé tant qu'aucun probe n'a persisté de matrice pour la destination.
 */
export const UNPROBED_CAPABILITIES: StorageCapabilities = {
  read: false,
  write: false,
  delete: false,
  move: false,
  checksum: false,
  atomicCommit: false,
  serverSideEncryption: false,
}

export interface ObjectStat {
  /**
   * Clé COMPLÈTE (préfixe inclus), directement acceptée par `delete()`,
   * `get()` et `stat()`. Un `list(prefix)` ne renvoie jamais un chemin relatif.
   */
  key: string
  size: number
  modifiedAt?: string
}

export interface PutOptions {
  /** Taille connue à l'avance (permet aux backends de streamer sans buffer). */
  size?: number
  contentType?: string
}

export interface PutResult {
  key: string
  size: number
  checksum?: string
}

export type HashAlgorithm = "sha256"

export type CommitMode = "atomic-rename" | "copy-verify-delete"

export interface CommitPayloadInput {
  stagingKey: string
  finalKey: string
  /** Checksum calculé pendant le transfert (référence d'intégrité). */
  expectedChecksum: string
  /** Taille calculée pendant le transfert (vérification toujours possible). */
  expectedSizeBytes: number
}

export interface StorageProvider {
  readonly id: string
  capabilities(): StorageCapabilities
  /**
   * Écrit un PETIT objet (manifest, checksum, métadonnées). Les implémentations
   * peuvent bufferiser un `Readable` : ce n'est pas un chemin de streaming pour
   * le payload de backup, qui passe par `StagingSink` côté producteur.
   */
  put(key: string, data: Readable | Buffer, opts?: PutOptions): Promise<PutResult>
  /**
   * Lecture d'un objet. Optionnel en V1 : non implémenté pour le backend Swarm
   * (l'orchestration du restore est hors périmètre). Le contrat reste présent
   * pour ne pas verrouiller le format.
   */
  get(key: string): Promise<Readable>
  stat(key: string): Promise<ObjectStat | null>
  list(prefix: string): Promise<ObjectStat[]>
  delete(key: string): Promise<void>
  /** `false` = non supporté par le backend (l'appelant dégrade en copy+verify+delete). */
  move(from: string, to: string): Promise<boolean>
  hash(key: string, algorithm?: HashAlgorithm): Promise<string | null>
  /**
   * Promotion d'un payload de staging vers sa clé finale.
   *
   * Contrat de vérification, identique pour tous les backends :
   *  - la TAILLE distante est toujours vérifiée (`expectedSizeBytes`) ;
   *  - le CHECKSUM est vérifié en plus si `hash()` le fournit ;
   *  - si le checksum n'est pas disponible, la vérification par taille reste
   *    la référence — cohérente avec le downgrade décidé par le lifecycle.
   *
   * Le mécanisme — `atomic-rename` (move) ou `copy-verify-delete` (fallback si
   * le backend n'expose pas de rename) — est choisi par l'implémentation selon
   * SES capacités ; la valeur renvoyée est le mode RÉELLEMENT exécuté et doit
   * être consignée telle quelle dans le manifest (`commit.mode`). Le Backup
   * Engine ne suppose jamais le mode : il l'interroge.
   */
  commitPayload(input: CommitPayloadInput): Promise<CommitMode>
}

/**
 * Primitive d'EXÉCUTION du streaming, distincte du contrat `StorageProvider`.
 *
 * Le producteur (extraction) doit envoyer son flux vers un objet de staging
 * sans écrire d'archive locale. Pour que le Backup Engine ne connaisse pas
 * rclone, c'est l'adapter de stockage qui fournit la commande d'upload ; le
 * runner se contente de composer `extraction | <commande fournie>`.
 *
 * `StagingSink` est spécifique au transport Swarm actuel : un futur provider
 * natif (API HTTP, SDK cloud) n'a pas à implémenter des commandes shell pour
 * satisfaire `StorageProvider` — il fournira sa propre primitive de streaming.
 */
export interface StagingSink {
  /** Commande shell qui uploade stdin vers `key` (credentials via secret). */
  stagingUploadScript(key: string): string
  /** Remote-string (credentials incluses) à monter en secret pour le task. */
  remoteString(): string
  /** Secret de transport additionnel (clé SFTP / JSON GCS), s'il en faut un. */
  transportSecret(): { material: string; target: string } | null
}

/** Capacités minimales d'un backend en lecture seule (jamais utilisé tel quel). */
export const READ_ONLY_CAPABILITIES: StorageCapabilities = {
  read: true,
  write: false,
  delete: false,
  move: false,
  checksum: false,
  atomicCommit: false,
  serverSideEncryption: false,
}
