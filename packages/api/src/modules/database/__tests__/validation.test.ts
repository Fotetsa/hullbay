import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { validateDatabaseConfig, DatabaseValidationError } from "../validation.js"
import {
  defaultReplicas,
  effectiveConsensus,
  effectiveReplicas,
  allowedReplicas,
} from "../topology.js"
import type { DatabaseConfig } from "@hullbay/shared"

const base: DatabaseConfig = {
  engine: "postgres",
  version: "16.3",
  mode: "single",
  topology: { replicas: 1 },
  storage: { driver: "local", driverOpts: {}, external: false },
  credentials: { username: "app", passwordSecretRef: "db_pg_password", database: "app" },
  retainDataOnDelete: true,
}

function cfg(overrides: Partial<DatabaseConfig>): DatabaseConfig {
  return { ...base, ...overrides }
}

describe("validateDatabaseConfig", () => {
  it("S2-01: postgres single valide", () => {
    const parsed = validateDatabaseConfig(cfg({}))
    expect(parsed.engine).toBe("postgres")
  })

  it("S1-03: postgres HA valide (replicas 3)", () => {
    const parsed = validateDatabaseConfig(cfg({ mode: "ha", topology: { replicas: 3 } }))
    expect(parsed.topology.replicas).toBe(3)
  })

  it("S2-02: replicas invalides rejetées avant réconciliation", () => {
    expect(() =>
      validateDatabaseConfig(cfg({ mode: "ha", topology: { replicas: 2 } }))
    ).toThrow(DatabaseValidationError)
  })

  it("S2-03: pas de mutation silencieuse 2→3", () => {
    try {
      validateDatabaseConfig(cfg({ mode: "ha", topology: { replicas: 2 } }))
      expect.unreachable("doit lever")
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseValidationError)
      const issues = (err as DatabaseValidationError).issues
      expect(issues[0]).toContain("replicas doit être dans [3, 5, 7]")
    }
  })

  it("S4-03: HA postgres avec replicas pair rejeté (règle moteur, pas règle globale)", () => {
    expect(() =>
      validateDatabaseConfig(cfg({ mode: "ha", topology: { replicas: 4 } }))
    ).toThrow(DatabaseValidationError)
  })

  it("S8-02: redis HA autorise des replicas pairs (pas de règle globale impair)", () => {
    const parsed = validateDatabaseConfig(
      cfg({ engine: "redis", mode: "ha", topology: { replicas: 2 } })
    )
    expect(parsed.topology.replicas).toBe(2)
  })

  it("S8-03: consensusReplicas interdit pour un moteur sans consensus", () => {
    expect(() =>
      validateDatabaseConfig(
        cfg({ engine: "mongodb", mode: "ha", topology: { replicas: 3, consensusReplicas: 3 } })
      )
    ).toThrow(/consensusReplicas interdit/)
  })

  it("consensusReplicas interdit en mode single (aucun consensus)", () => {
    expect(() =>
      validateDatabaseConfig(cfg({ topology: { replicas: 1, consensusReplicas: 3 } }))
    ).toThrow(/postgres\/single n'a pas de consensus découplé/)
    expect(() =>
      validateDatabaseConfig(
        cfg({ engine: "redis", topology: { replicas: 1, consensusReplicas: 3 } })
      )
    ).toThrow(/redis\/single n'a pas de consensus découplé/)
  })

  it("S4-02: consensusReplicas découplé des data-replicas (postgres)", () => {
    const parsed = validateDatabaseConfig(
      cfg({ mode: "ha", topology: { replicas: 3, consensusReplicas: 5 } })
    )
    expect(parsed.topology.consensusReplicas).toBe(5)
  })

  it("S8-04: consensusReplicas hors valeurs autorisées rejeté", () => {
    expect(() =>
      validateDatabaseConfig(
        cfg({ engine: "redis", mode: "ha", topology: { replicas: 3, consensusReplicas: 4 } })
      )
    ).toThrow(/consensusReplicas doit être dans \[3, 5\]/)
  })

  it("mode ha sans topology : défaut replicas du moteur (pas 1)", () => {
    const parsed = validateDatabaseConfig(cfg({ mode: "ha", topology: {} }))
    expect(parsed.topology.replicas).toBeUndefined()
    expect(effectiveReplicas(parsed)).toBe(3)
  })

  it("schéma : version latest rejetée", () => {
    expect(() => validateDatabaseConfig(cfg({ version: "latest" }))).toThrow()
  })

  it("schéma brisé → DatabaseValidationError (pas de ZodError brut → 422 propre)", () => {
    // engine inconnu : échoue à la parse Zod (n'est PAS une règle de topologie).
    for (const bad of [
      { engine: "cassandra" },
      { credentials: undefined },
      { credentials: { username: "app", passwordSecretRef: "ok", database: "app", password: "en-clair" } },
    ]) {
      try {
        validateDatabaseConfig({ ...base, ...bad })
        expect.unreachable("doit lever")
      } catch (err) {
        expect(err).toBeInstanceOf(DatabaseValidationError)
        const issues = (err as DatabaseValidationError).issues
        expect(issues.length).toBeGreaterThan(0)
      }
    }
  })
})

describe("Helpers de topologie", () => {
  it("defaultReplicas par moteur/mode", () => {
    expect(defaultReplicas("postgres", "single")).toBe(1)
    expect(defaultReplicas("postgres", "ha")).toBe(3)
    expect(defaultReplicas("redis", "ha")).toBe(2)
  })

  it("allowedReplicas par moteur/mode", () => {
    expect(allowedReplicas("mysql", "ha")).toEqual([3, 5])
    expect(allowedReplicas("mongodb", "single")).toEqual([1])
  })

  it("effectiveReplicas : explicite ou défaut moteur/mode", () => {
    expect(effectiveReplicas(cfg({}))).toBe(1)
    expect(effectiveReplicas(cfg({ mode: "ha", topology: {} }))).toBe(3)
    expect(effectiveReplicas(cfg({ mode: "ha", topology: { replicas: 5 } }))).toBe(5)
  })

  it("effectiveConsensus : défaut moteur, explicite ou null", () => {
    expect(effectiveConsensus(cfg({ mode: "ha" }))).toBe(3)
    expect(effectiveConsensus(cfg({ mode: "ha", topology: { replicas: 3, consensusReplicas: 5 } }))).toBe(5)
    expect(effectiveConsensus(cfg({ engine: "mysql", mode: "ha" }))).toBeNull()
    expect(effectiveConsensus(cfg({}))).toBeNull()
  })
})

describe("Pureté du module (spec §19)", () => {
  const dir = resolve(fileURLToPath(new URL("..", import.meta.url)))

  it("S2-10: aucun import dockerode/prisma/ssh-tunnel", () => {
    for (const file of [
      "types.ts",
      "topology.ts",
      "validation.ts",
      "index.ts",
      "providers/index.ts",
      "providers/postgres.ts",
    ]) {
      const src = readFileSync(resolve(dir, file), "utf8")
      const imports = src
        .split("\n")
        .filter((line) => line.trim().startsWith("import "))
        .join("\n")
      expect(imports).not.toMatch(/dockerode|\.\.\/\.\.\/lib\/prisma|ssh-tunnel/)
    }
  })
})
