import { describe, it, expect } from "vitest"
import {
  NodeType,
  NodeConfigSchemas,
  parseNodeConfig,
  edgeKindForPair,
  isConnectionAllowed,
  DatabaseConfigSchema,
  ContainerConfigSchema,
  PlacementSchema,
  DatabaseEngineSchema,
  DatabaseModeSchema,
} from "../node-config.js"
import { EdgeKind } from "../entities.js"
import { LabelKeys } from "../labels.js"

function validDatabaseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    engine: "postgres",
    version: "16.3",
    mode: "single",
    topology: { replicas: 1 },
    storage: { sizeGb: 20 },
    resources: { cpus: 0.5, memMb: 512 },
    credentials: { username: "app", passwordSecretRef: "db_pg_password", database: "app" },
    retainDataOnDelete: true,
    ...overrides,
  }
}

describe("NodeType / parseNodeConfig", () => {
  it("S1-01: NodeType inclut database et parseNodeConfig l'accepte", () => {
    expect(NodeType.options).toContain("database")
    const parsed = parseNodeConfig("database", validDatabaseConfig())
    expect(parsed.engine).toBe("postgres")
  })

  it("rejette un type de nœud inconnu", () => {
    expect(() => parseNodeConfig("router" as never, {})).toThrow()
  })

  it("S1-11: NodeConfigSchemas expose database", () => {
    expect(NodeConfigSchemas.database).toBe(DatabaseConfigSchema)
  })
})

describe("DatabaseConfigSchema", () => {
  it("S1-02: single valide, défauts appliqués", () => {
    const parsed = DatabaseConfigSchema.parse(validDatabaseConfig())
    expect(parsed.mode).toBe("single")
    expect(parsed.retainDataOnDelete).toBe(true)
    expect(parsed.topology.replicas).toBe(1)
    expect(parsed.storage.driver).toBe("local")
  })

  it("S1-03: HA valide", () => {
    const parsed = DatabaseConfigSchema.parse(
      validDatabaseConfig({ mode: "ha", topology: { replicas: 3 } })
    )
    expect(parsed.mode).toBe("ha")
    expect(parsed.topology.replicas).toBe(3)
  })

  it("rejette un moteur inconnu", () => {
    expect(() => DatabaseConfigSchema.parse(validDatabaseConfig({ engine: "oracle" }))).toThrow()
  })

  it("S1-04: champ mot de passe en clair rejeté (clé inconnue)", () => {
    const cfg = validDatabaseConfig()
    ;(cfg.credentials as Record<string, unknown>).password = "hunter2"
    expect(() => DatabaseConfigSchema.parse(cfg)).toThrow()
  })

  it("S1-05: version latest rejetée", () => {
    expect(() => DatabaseConfigSchema.parse(validDatabaseConfig({ version: "latest" }))).toThrow()
  })

  it("credentials : passwordSecretRef PÉNIBLE au schéma, jamais la valeur en clair", () => {
    // Secret non encore choisi = état normal d'un nœud neuf (pas d'erreur).
    const missing = DatabaseConfigSchema.parse(
      validDatabaseConfig({ credentials: { username: "app", database: "app" } })
    )
    expect(missing.credentials.passwordSecretRef).toBeUndefined()
    // Toujours interdit : la valeur en clair et les clés inconnues.
    const cfg = validDatabaseConfig()
    ;(cfg.credentials as Record<string, unknown>).password = "hunter2"
    expect(() => DatabaseConfigSchema.parse(cfg)).toThrow()
    expect(() =>
      DatabaseConfigSchema.parse(
        validDatabaseConfig({ credentials: { username: "app", password: "x", database: "app" } })
      )
    ).toThrow()
  })

  it("storage external exige externalName", () => {
    expect(() =>
      DatabaseConfigSchema.parse(
        validDatabaseConfig({ storage: { external: true, sizeGb: 20 } })
      )
    ).toThrow()
    const ok = DatabaseConfigSchema.parse(
      validDatabaseConfig({ storage: { external: true, externalName: "data_vault", sizeGb: 20 } })
    )
    expect(ok.storage.externalName).toBe("data_vault")
  })

  it("topology.consensusReplicas découplé des data-replicas", () => {
    const parsed = DatabaseConfigSchema.parse(
      validDatabaseConfig({ topology: { replicas: 3, consensusReplicas: 5 } })
    )
    expect(parsed.topology.consensusReplicas).toBe(5)
  })
})

describe("Placement (S1-06)", () => {
  it("placement schéma valide", () => {
    const placement = PlacementSchema.parse({
      constraints: ["node.role==worker"],
      spreadOver: ["node.labels.rack"],
    })
    expect(placement.constraints).toHaveLength(1)
    expect(placement.spreadOver).toContain("node.labels.rack")
  })

  it("placement optionnel dans ContainerConfigSchema", () => {
    const withPlacement = ContainerConfigSchema.parse({
      image: "nginx",
      tag: "1.27",
      placement: { constraints: ["node.role==manager"] },
    })
    expect(withPlacement.placement?.constraints).toEqual(["node.role==manager"])
  })

  it("rétrocompatible : conteneur sans placement", () => {
    const plain = ContainerConfigSchema.parse({ image: "nginx", tag: "1.27" })
    expect(plain.placement).toBeUndefined()
  })
})

describe("EdgeKind et matrice de connexion", () => {
  it("S1-07: EdgeKind inclut database", () => {
    expect(EdgeKind.options).toContain("database")
    expect(EdgeKind.parse("database")).toBe("database")
  })

  it("S1-08: paire container↔database autorisée des deux sens", () => {
    expect(edgeKindForPair("container", "database")).toBe("database")
    expect(edgeKindForPair("database", "container")).toBe("database")
    expect(isConnectionAllowed("container", "database")).toBe(true)
  })

  it("S1-09: paire database↔volume interdite", () => {
    expect(edgeKindForPair("database", "volume")).toBeNull()
    expect(isConnectionAllowed("database", "volume")).toBe(false)
  })

  it("les paires existantes sont préservées", () => {
    expect(edgeKindForPair("container", "network")).toBe("network")
    expect(edgeKindForPair("container", "volume")).toBe("volume")
    expect(edgeKindForPair("container", "gateway")).toBe("gateway")
  })
})

describe("Enums moteur/mode", () => {
  it("les 4 moteurs cibles sont couverts", () => {
    expect(DatabaseEngineSchema.options).toEqual(["postgres", "mysql", "mongodb", "redis"])
  })

  it("les deux modes", () => {
    expect(DatabaseModeSchema.options).toEqual(["single", "ha"])
  })
})

describe("Labels d'ownership database (S1-10)", () => {
  it("clés bozando.database.* présentes", () => {
    expect(LabelKeys.dbParent).toBe("bozando.database.parent")
    expect(LabelKeys.dbRole).toBe("bozando.database.role")
    expect(LabelKeys.dbIndex).toBe("bozando.database.index")
    expect(LabelKeys.dbEngine).toBe("bozando.database.engine")
    expect(LabelKeys.dbParentConfig).toBe("bozando.database.parentConfig")
    expect(LabelKeys.dbData).toBe("bozando.database.data")
  })
})
