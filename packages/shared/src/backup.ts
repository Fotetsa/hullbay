import { z } from "zod"

/**
 * Contrats partagés du Backup Engine (api + web).
 *
 * Règle : ces schémas décrivent la FORME, jamais les valeurs secrètes en clair.
 * Une destination transporte des noms de champs ; les valeurs sensibles sont
 * chiffrées côté API (scope "backup") et ne sont jamais renvoyées au client.
 *
 * Aucun enum Prisma n'est dupliqué ici : les unions de chaînes sont la source
 * de vérité runtime, ce qui permet d'ajouter une stratégie ou un protocole
 * sans migration SQL. La cohérence avec la base est garantie par les tests.
 */

/** Version du format d'artifact. Toute évolution incrémente et garde un parser. */
export const BACKUP_FORMAT_VERSION = 1

/** Algorithme d'intégrité unique en V1. */
export const BACKUP_CHECKSUM_ALGORITHM = "sha256"

export const BackupTargetKindSchema = z.enum([
  "postgres",
  "mysql",
  "mongodb",
  "redis",
  "volume",
])
export type BackupTargetKind = z.infer<typeof BackupTargetKindSchema>

/**
 * Stratégie native par type de cible. Le backend reste la source de vérité
 * (registry) ; cette table permet au front d'afficher la stratégie imposée sans
 * deviner, et un test API vérifie qu'elle correspond au registry.
 */
export const BACKUP_STRATEGY_BY_KIND: Record<BackupTargetKind, string> = {
  postgres: "postgres.pg_dump",
  mysql: "mysql.mysqldump",
  mongodb: "mongodb.mongodump",
  redis: "redis.rdb",
  volume: "volume.tar",
}

export const BackupProtocolSchema = z.enum([
  "s3",
  "sftp",
  "webdav",
  "smb",
  "gcs",
  "azureblob",
])
export type BackupProtocol = z.infer<typeof BackupProtocolSchema>

export const BackupScheduleSchema = z.enum(["manual", "daily", "weekly"])
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>

export const BackupVerificationSchema = z.enum(["size", "checksum"])
export type BackupVerification = z.infer<typeof BackupVerificationSchema>

/**
 * Chiffrement du PAYLOAD de l'artifact (reviewer #12).
 *
 * À ne pas confondre avec le chiffrement des CREDENTIALS de destination, qui est
 * un mécanisme distinct (secrets chiffrés au repos côté API). Les deux concepts
 * sont volontairement séparés : le chiffrement des données de sauvegarde est sa
 * propre politique, future (« age »/« gpg »), indépendante des credentials.
 */
export const BackupEncryptionModeSchema = z.enum(["none"])
export type BackupEncryptionMode = z.infer<typeof BackupEncryptionModeSchema>

export const BackupRunStatusSchema = z.enum(["RUNNING", "COMPLETED", "FAILED"])
export type BackupRunStatus = z.infer<typeof BackupRunStatusSchema>

export const BackupRunPhaseSchema = z.enum([
  "resolving",
  "extracting",
  "transferring",
  "verifying",
  "committing",
  "retention",
  "done",
])
export type BackupRunPhase = z.infer<typeof BackupRunPhaseSchema>

// ── Destination : champs par protocole ───────────────────────────────────────
// Les champs marqués "secret" sont chiffrés au repos et jamais sérialisés en
// réponse. Les autres sont des identifiants de connexion, non sensibles.

const port = z.number().int().min(1).max(65535)
const nonEmpty = z.string().min(1)
const optionalNonEmpty = z.string().min(1).optional()

export const S3DestinationFieldsSchema = z
  .object({
    protocol: z.literal("s3"),
    endpoint: optionalNonEmpty,
    bucket: nonEmpty,
    region: optionalNonEmpty,
    accessKeyId: nonEmpty,
    secretAccessKey: nonEmpty,
    useTls: z.boolean().default(true),
    pathStyle: z.boolean().default(false),
  })
  .strict()

export const SftpDestinationFieldsSchema = z
  .object({
    protocol: z.literal("sftp"),
    host: nonEmpty,
    port: port.default(22),
    username: nonEmpty,
    password: optionalNonEmpty,
    privateKey: optionalNonEmpty,
    hostKeyFingerprint: optionalNonEmpty,
  })
  .strict()

export const WebdavDestinationFieldsSchema = z
  .object({
    protocol: z.literal("webdav"),
    url: z.string().url(),
    username: nonEmpty,
    password: nonEmpty,
  })
  .strict()

export const SmbDestinationFieldsSchema = z
  .object({
    protocol: z.literal("smb"),
    host: nonEmpty,
    share: nonEmpty,
    username: nonEmpty,
    password: nonEmpty,
    domain: optionalNonEmpty,
  })
  .strict()

export const GcsDestinationFieldsSchema = z
  .object({
    protocol: z.literal("gcs"),
    bucket: nonEmpty,
    serviceAccountJson: nonEmpty,
  })
  .strict()

export const AzureBlobDestinationFieldsSchema = z
  .object({
    protocol: z.literal("azureblob"),
    accountName: nonEmpty,
    container: nonEmpty,
    accountKey: nonEmpty,
  })
  .strict()

export const BackupDestinationFieldsSchema = z
  .discriminatedUnion("protocol", [
    S3DestinationFieldsSchema,
    SftpDestinationFieldsSchema,
    WebdavDestinationFieldsSchema,
    SmbDestinationFieldsSchema,
    GcsDestinationFieldsSchema,
    AzureBlobDestinationFieldsSchema,
  ])
  .refine((v) => v.protocol !== "sftp" || Boolean(v.password) || Boolean(v.privateKey), {
    message: "password ou privateKey requis",
    path: ["password"],
  })
export type BackupDestinationFields = z.infer<
  typeof BackupDestinationFieldsSchema
>

/** Champs qui doivent être chiffrés avant persistance (jamais renvoyés). */
export const BACKUP_SECRET_FIELDS: Record<BackupProtocol, readonly string[]> = {
  s3: ["accessKeyId", "secretAccessKey"],
  sftp: ["password", "privateKey"],
  webdav: ["password"],
  smb: ["password"],
  gcs: ["serviceAccountJson"],
  azureblob: ["accountKey"],
}

/**
 * Descripteur d'affichage des champs par protocole.
 *
 * Le front ne devine pas les champs : il rend ce descripteur, et un test vérifie
 * qu'il correspond EXACTEMENT au schéma Zod ci-dessus (aucun champ fantôme, aucun
 * champ oublié). Les libellés restent dans l'i18n.
 */
export type BackupDestinationFieldType =
  | "text"
  | "password"
  | "number"
  | "boolean"
  | "textarea"

export interface BackupDestinationFieldSpec {
  key: string
  type: BackupDestinationFieldType
  required: boolean
  defaultValue?: string | number | boolean
}

export const BACKUP_DESTINATION_FIELD_SPECS: Record<
  BackupProtocol,
  readonly BackupDestinationFieldSpec[]
> = {
  s3: [
    { key: "endpoint", type: "text", required: false },
    { key: "bucket", type: "text", required: true },
    { key: "region", type: "text", required: false },
    { key: "accessKeyId", type: "text", required: true },
    { key: "secretAccessKey", type: "password", required: true },
    { key: "useTls", type: "boolean", required: false, defaultValue: true },
    { key: "pathStyle", type: "boolean", required: false, defaultValue: false },
  ],
  sftp: [
    { key: "host", type: "text", required: true },
    { key: "port", type: "number", required: false, defaultValue: 22 },
    { key: "username", type: "text", required: true },
    { key: "password", type: "password", required: false },
    { key: "privateKey", type: "textarea", required: false },
    { key: "hostKeyFingerprint", type: "text", required: false },
  ],
  webdav: [
    { key: "url", type: "text", required: true },
    { key: "username", type: "text", required: true },
    { key: "password", type: "password", required: true },
  ],
  smb: [
    { key: "host", type: "text", required: true },
    { key: "share", type: "text", required: true },
    { key: "username", type: "text", required: true },
    { key: "password", type: "password", required: true },
    { key: "domain", type: "text", required: false },
  ],
  gcs: [
    { key: "bucket", type: "text", required: true },
    { key: "serviceAccountJson", type: "textarea", required: true },
  ],
  azureblob: [
    { key: "accountName", type: "text", required: true },
    { key: "container", type: "text", required: true },
    { key: "accountKey", type: "password", required: true },
  ],
}

export const CreateBackupDestinationSchema = z
  .object({
    name: nonEmpty,
    basePath: nonEmpty.refine((v) => !v.startsWith("/"), {
      message: "basePath est relatif au backend (pas de / initial)",
    }),
    projectId: optionalNonEmpty,
    config: BackupDestinationFieldsSchema,
  })
  .strict()
export type CreateBackupDestinationInput = z.infer<
  typeof CreateBackupDestinationSchema
>

/** Vue publique d'une destination : aucun champ secret. */
export const BackupDestinationViewSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
  protocol: BackupProtocolSchema,
  basePath: nonEmpty,
  projectId: z.string().nullable(),
  lastTestedAt: z.string().nullable(),
  capabilities: z
    .object({
      read: z.boolean(),
      write: z.boolean(),
      delete: z.boolean(),
      move: z.boolean(),
      checksum: z.boolean(),
      atomicCommit: z.boolean(),
    })
    .nullable(),
  createdAt: z.string(),
})
export type BackupDestinationView = z.infer<
  typeof BackupDestinationViewSchema
>

// ── Policy ───────────────────────────────────────────────────────────────────

export const BackupPlacementSchema = z
  .object({
    constraints: z.array(z.string().min(1)).default([]),
    spreadOver: z.array(z.string().min(1)).default([]),
  })
  .strict()

export const BackupPolicyInputSchema = z
  .object({
    targetId: nonEmpty,
    destinationId: nonEmpty,
    strategyId: nonEmpty,
    schedule: BackupScheduleSchema.default("manual"),
    scheduleHourUtc: z.number().int().min(0).max(23).optional(),
    retentionDays: z.number().int().min(1).max(3650).default(30),
    verification: BackupVerificationSchema.default("checksum"),
    encryptionMode: BackupEncryptionModeSchema.default("none"),
    placement: BackupPlacementSchema.optional(),
    timeoutSec: z.number().int().min(60).max(86_400).default(1800),
    maxConcurrency: z.number().int().min(1).max(16).default(1),
    enabled: z.boolean().default(true),
  })
  .strict()
export type BackupPolicyInput = z.infer<typeof BackupPolicyInputSchema>

// ── Manifest d'artifact ──────────────────────────────────────────────────────
// Contrat de format : un artifact est auto-descriptif et restaurable sans
// Hullbay. Le manifest est uploadé EN DERNIER — sa présence vaut commit.

export const BackupManifestTargetSchema = z
  .object({
    nodeId: nonEmpty,
    name: nonEmpty,
    kind: BackupTargetKindSchema,
  })
  .strict()

/**
 * Identité de la source, SANS détails d'infrastructure réseau.
 *
 * Un artifact exporté ne doit pas exposer host/port/username (reviewer #14) :
 * il décrit CE QUI a été sauvegardé (moteur, version, nom de base) et non
 * COMMENT s'y connecter. Les credentials et la topologie restent côté Hullbay.
 */
export const BackupManifestSourceSchema = z
  .object({
    engine: nonEmpty,
    engineVersion: nonEmpty,
    database: optionalNonEmpty,
  })
  .strict()

export const BackupManifestStrategySchema = z
  .object({
    id: nonEmpty,
    version: z.number().int().min(1),
    tool: nonEmpty,
    toolVersion: nonEmpty,
  })
  .strict()

export const BackupManifestPayloadSchema = z
  .object({
    path: nonEmpty,
    format: nonEmpty,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()

export const BackupManifestChecksumSchema = z
  .object({
    algorithm: z.literal(BACKUP_CHECKSUM_ALGORITHM),
    value: z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex attendu"),
  })
  .strict()

export const BackupManifestRestoreSchema = z
  .object({
    strategyId: nonEmpty,
    command: nonEmpty,
    requires: z.record(z.string(), z.string()).default({}),
  })
  .strict()

/**
 * Vérification réellement appliquée à l'artifact.
 *
 * `mode` = ce qui a été exigé par la policy ; `downgraded` = vrai quand le
 * backend de stockage ne supporte pas le hash natif et que la vérification a
 * été rétrogradée vers le contrôle de taille (jamais silencieuse : ce drapeau
 * est consigné dans l'artifact et visible au restore).
 */
export const BackupManifestVerificationSchema = z
  .object({
    mode: BackupVerificationSchema,
    downgraded: z.boolean().default(false),
  })
  .strict()

export const BackupManifestSchema = z
  .object({
    formatVersion: z.number().int().min(1),
    artifactId: nonEmpty,
    runId: nonEmpty,
    createdAt: z.string().datetime(),
    target: BackupManifestTargetSchema,
    source: BackupManifestSourceSchema,
    strategy: BackupManifestStrategySchema,
    payload: BackupManifestPayloadSchema,
    checksum: BackupManifestChecksumSchema,
    encryption: z.object({ mode: BackupEncryptionModeSchema }).strict(),
    verification: BackupManifestVerificationSchema,
    commit: z
      .object({ mode: z.enum(["atomic-rename", "copy-verify-delete"]) })
      .strict(),
    restore: BackupManifestRestoreSchema,
  })
  .strict()
export type BackupManifest = z.infer<typeof BackupManifestSchema>

/**
 * Un manifest d'une version future n'est pas silencieusement accepté : on
 * refuse explicitement au lieu de produire une restauration incomplète.
 */
export function parseBackupManifest(input: unknown): BackupManifest {
  const manifest = BackupManifestSchema.parse(input)
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `format d'artifact non supporté : v${manifest.formatVersion} > v${BACKUP_FORMAT_VERSION}`,
    )
  }
  return manifest
}
