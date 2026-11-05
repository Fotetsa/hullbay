import { describe, expect, it } from "vitest"
import {
  BACKUP_DESTINATION_FIELD_SPECS,
  BACKUP_FORMAT_VERSION,
  BackupDestinationFieldsSchema,
  BackupManifestSchema,
  BackupPolicyInputSchema,
  CreateBackupDestinationSchema,
  parseBackupManifest,
  S3DestinationFieldsSchema,
  SftpDestinationFieldsSchema,
  WebdavDestinationFieldsSchema,
  SmbDestinationFieldsSchema,
  GcsDestinationFieldsSchema,
  AzureBlobDestinationFieldsSchema,
} from "../backup.js"

const sha = "a".repeat(64)

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    artifactId: "bak_1",
    runId: "run_1",
    createdAt: "2026-10-25T10:00:00.000Z",
    target: { nodeId: "node_1", name: "orders-db", kind: "postgres" },
    source: {
      engine: "postgres",
      engineVersion: "16",
      host: "boz_shop_db",
      port: 5432,
      database: "orders",
      username: "app",
    },
    strategy: {
      id: "postgres.pg_dump",
      version: 1,
      tool: "pg_dump",
      toolVersion: "16.4",
    },
    payload: { path: "payload.sql.gz", format: "sql.gz", sizeBytes: 42 },
    checksum: { algorithm: "sha256", value: sha },
    encryption: { mode: "none" },
    commit: { mode: "atomic-rename" },
    restore: {
      strategyId: "postgres.pg_dump",
      command: "gunzip -c payload.sql.gz | psql",
      requires: { engineMajor: ">=16" },
    },
    ...overrides,
  }
}

describe("destinations : un protocole n'accepte que ses propres champs", () => {
  it("accepte une destination S3 complète", () => {
    const parsed = BackupDestinationFieldsSchema.parse({
      protocol: "s3",
      bucket: "backups",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    })
    expect(parsed.protocol).toBe("s3")
    expect(parsed).toMatchObject({ useTls: true, pathStyle: false })
  })

  it("rejette un champ d'un autre protocole", () => {
    const result = BackupDestinationFieldsSchema.safeParse({
      protocol: "s3",
      bucket: "backups",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      host: "nas.local",
    })
    expect(result.success).toBe(false)
  })

  it("exige un mot de passe ou une clé privée pour SFTP", () => {
    const base = {
      protocol: "sftp" as const,
      host: "storage.example",
      username: "backup",
    }
    expect(BackupDestinationFieldsSchema.safeParse(base).success).toBe(false)
    expect(
      BackupDestinationFieldsSchema.safeParse({ ...base, password: "x" }).success,
    ).toBe(true)
    expect(
      BackupDestinationFieldsSchema.safeParse({ ...base, privateKey: "-----BEGIN" })
        .success,
    ).toBe(true)
  })

  it("valide une URL WebDAV absolue", () => {
    expect(
      BackupDestinationFieldsSchema.safeParse({
        protocol: "webdav",
        url: "https://cloud.example/remote.php/dav/files/u",
        username: "u",
        password: "p",
      }).success,
    ).toBe(true)
    expect(
      BackupDestinationFieldsSchema.safeParse({
        protocol: "webdav",
        url: "pas-une-url",
        username: "u",
        password: "p",
      }).success,
    ).toBe(false)
  })
})

describe("destination : basePath relatif uniquement", () => {
  it("refuse un chemin absolu (le backend possède sa racine)", () => {
    const result = CreateBackupDestinationSchema.safeParse({
      name: "prod",
      basePath: "/backups",
      config: {
        protocol: "s3",
        bucket: "b",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
    })
    expect(result.success).toBe(false)
  })

  it("accepte un préfixe relatif", () => {
    const result = CreateBackupDestinationSchema.safeParse({
      name: "prod",
      basePath: "hullbay/prod",
      config: {
        protocol: "s3",
        bucket: "b",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
    })
    expect(result.success).toBe(true)
  })
})

describe("policy", () => {
  it("applique des valeurs par défaut sûres", () => {
    const policy = BackupPolicyInputSchema.parse({
      targetId: "t1",
      destinationId: "d1",
      strategyId: "postgres.pg_dump",
    })
    expect(policy).toMatchObject({
      schedule: "manual",
      retentionDays: 30,
      verification: "checksum",
      encryptionMode: "none",
      timeoutSec: 1800,
      maxConcurrency: 1,
      enabled: true,
    })
  })

  it("borne la rétention et l'heure de planification", () => {
    const base = {
      targetId: "t1",
      destinationId: "d1",
      strategyId: "postgres.pg_dump",
    }
    expect(
      BackupPolicyInputSchema.safeParse({ ...base, retentionDays: 0 }).success,
    ).toBe(false)
    expect(
      BackupPolicyInputSchema.safeParse({ ...base, scheduleHourUtc: 24 }).success,
    ).toBe(false)
    expect(
      BackupPolicyInputSchema.safeParse({ ...base, timeoutSec: 10 }).success,
    ).toBe(false)
  })
})

describe("manifest", () => {
  it("accepte un manifest complet", () => {
    expect(BackupManifestSchema.safeParse(validManifest()).success).toBe(true)
  })

  it("refuse un checksum qui n'est pas un sha256 hexadécimal", () => {
    const result = BackupManifestSchema.safeParse(
      validManifest({ checksum: { algorithm: "sha256", value: "trop-court" } }),
    )
    expect(result.success).toBe(false)
  })

  it("refuse un manifest sans informations de restauration", () => {
    const { restore: _restore, ...withoutRestore } = validManifest()
    expect(BackupManifestSchema.safeParse(withoutRestore).success).toBe(false)
  })

  it("refuse explicitement un format futur au lieu de l'interpréter", () => {
    expect(() =>
      parseBackupManifest(validManifest({ formatVersion: BACKUP_FORMAT_VERSION + 1 })),
    ).toThrow(/format d'artifact non supporté/)
  })

  it("lit un manifest de la version courante", () => {
    const manifest = parseBackupManifest(validManifest())
    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(manifest.checksum.value).toHaveLength(64)
  })
})

describe("descripteur d'affichage des destinations", () => {
  const schemas = {
    s3: S3DestinationFieldsSchema,
    sftp: SftpDestinationFieldsSchema,
    webdav: WebdavDestinationFieldsSchema,
    smb: SmbDestinationFieldsSchema,
    gcs: GcsDestinationFieldsSchema,
    azureblob: AzureBlobDestinationFieldsSchema,
  } as const

  it("couvre exactement les champs des schémas Zod, sans fantôme ni oubli", () => {
    for (const [protocol, schema] of Object.entries(schemas)) {
      const schemaKeys = Object.keys(schema.shape).filter((k) => k !== "protocol")
      const specKeys = BACKUP_DESTINATION_FIELD_SPECS[
        protocol as keyof typeof schemas
      ].map((f) => f.key)
      expect([...specKeys].sort(), protocol).toEqual(schemaKeys.sort())
    }
  })

  it("marque requis exactement les champs non optionnels", () => {
    for (const [protocol, schema] of Object.entries(schemas)) {
      for (const spec of BACKUP_DESTINATION_FIELD_SPECS[
        protocol as keyof typeof schemas
      ]) {
        const field = schema.shape[spec.key as keyof typeof schema.shape]
        const optional = field.safeParse(undefined).success
        expect(spec.required, `${protocol}.${spec.key}`).toBe(!optional)
      }
    }
  })

  it("ne classe en secret que des champs réellement sensibles", () => {
    const declared = new Set(
      Object.values(BACKUP_DESTINATION_FIELD_SPECS).flatMap((fields) =>
        fields.filter((f) => f.type === "password").map((f) => f.key),
      ),
    )
    expect(declared.has("secretAccessKey")).toBe(true)
    expect(declared.has("accountKey")).toBe(true)
    expect(declared.has("bucket")).toBe(false)
  })
})
