import { describe, expect, it } from "vitest"
import {
  artifactPrefix,
  buildManifest,
  parseBackupManifest,
  safeSegment,
} from "../manifest"

const input = {
  artifactId: "bak_1",
  runId: "run_1",
  target: { nodeId: "n1", name: "orders-db", kind: "postgres" as const },
  source: {
    engine: "postgres",
    engineVersion: "16",
    database: "orders",
  },
  strategy: { id: "postgres.pg_dump", version: 1, tool: "pg_dump", toolVersion: "16.4" },
  payload: { path: "payload.sql.gz", format: "sql.gz", sizeBytes: 10 },
  checksumSha256: "b".repeat(64),
  encryptionMode: "none" as const,
  verificationMode: "checksum" as const,
  verificationDowngraded: false,
  commitMode: "atomic-rename" as const,
  restore: { strategyId: "postgres.pg_dump", command: "gunzip -c payload.sql.gz | psql" },
  createdAt: new Date("2026-10-25T10:00:00Z"),
}

describe("buildManifest", () => {
  it("produit un manifest conforme et relisible", () => {
    const manifest = buildManifest(input)
    expect(manifest.formatVersion).toBe(1)
    expect(manifest.createdAt).toBe("2026-10-25T10:00:00.000Z")
    expect(manifest.checksum).toEqual({ algorithm: "sha256", value: "b".repeat(64) })
    expect(parseBackupManifest(manifest)).toEqual(manifest)
  })

  it("n'expose aucune info réseau/credential de la source (#14)", () => {
    const manifest = buildManifest(input)
    expect(manifest.source).toEqual({
      engine: "postgres",
      engineVersion: "16",
      database: "orders",
    })
    expect(manifest.source).not.toHaveProperty("host")
    expect(manifest.source).not.toHaveProperty("port")
    expect(manifest.source).not.toHaveProperty("username")
  })

  it("consigne le mode de vérif et le downgrade (#3)", () => {
    const manifest = buildManifest({
      ...input,
      verificationMode: "size",
      verificationDowngraded: true,
    })
    expect(manifest.verification).toEqual({ mode: "size", downgraded: true })
  })

  it("refuse un checksum non hexadécimal", () => {
    expect(() => buildManifest({ ...input, checksumSha256: "nope" })).toThrow()
  })

  it("conserve les prérequis de restauration", () => {
    const manifest = buildManifest({
      ...input,
      restore: {
        strategyId: "postgres.pg_dump",
        command: "gunzip -c payload.sql.gz | psql",
        requires: { engineMajor: ">=16" },
      },
    })
    expect(manifest.restore.requires).toEqual({ engineMajor: ">=16" })
  })
})

describe("artifactPrefix", () => {
  it("construit le chemin distant attendu", () => {
    expect(artifactPrefix("hullbay/prod", "shop", "orders-db", "bak_1")).toBe(
      "hullbay/prod/shop/orders-db/bak_1",
    )
  })

  it("neutralise une tentative de traversée de chemin", () => {
    const prefix = artifactPrefix("base", "../../etc", "../passwd", "bak_1")
    expect(prefix).not.toContain("..")
    expect(prefix.split("/")).toHaveLength(4)
  })

  it("normalise les caractères spéciaux d'un nom de cible", () => {
    expect(safeSegment("Base de données / prod")).toBe("Base-de-donnees-prod")
    expect(safeSegment("")).toBe("target")
    expect(safeSegment("....")).toBe("target")
  })
})
