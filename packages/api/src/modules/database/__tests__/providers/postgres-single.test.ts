import { describe, it, expect } from "vitest"
import { ContainerConfigSchema } from "@hullbay/shared"
import type { DatabaseConfig } from "@hullbay/shared"
import {
  expandPostgres,
  postgresProvider,
  postgresMemberServiceName,
} from "../../providers/postgres.js"
import { getDatabaseProvider, DATABASE_PROVIDERS } from "../../providers/index.js"
import { DatabaseValidationError } from "../../validation.js"
import type { ExpansionContext, GeneratedResource } from "../../types.js"

const ctx: ExpansionContext = {
  parentNodeId: "n_db_01",
  projectSlug: "proj-a",
  parentNode: {
    id: "n_db_01",
    name: "catalog",
    type: "database",
    config: {
      engine: "postgres",
      version: "16.3",
      mode: "single",
      topology: { replicas: 1 },
      storage: { driver: "local", driverOpts: {}, external: false },
      credentials: {
        username: "catalog",
        passwordSecretRef: "db_catalog_secret",
        database: "catalog_db",
      },
      retainDataOnDelete: true,
    },
  },
}

function cfg(overrides: Partial<DatabaseConfig>): DatabaseConfig {
  return { ...ctx.parentNode.config, ...overrides }
}

function containerOf(exp: ReturnType<typeof expandPostgres>) {
  const c = exp.resources.find((r) => r.kind === "container") as
    | (GeneratedResource & { kind: "container" })
    | undefined
  if (!c) throw new Error("conteneur membre absent")
  return c
}

describe("postgresProvider - registry", () => {
  it("postgres enregistré, tous les moteurs couverts", () => {
    expect(getDatabaseProvider("postgres")).toBe(postgresProvider)
    expect(getDatabaseProvider("mysql")).not.toBeNull()
    expect(getDatabaseProvider("mongodb")).not.toBeNull()
    expect(getDatabaseProvider("redis")).not.toBeNull()
    expect(DATABASE_PROVIDERS.postgres?.engine).toBe("postgres")
  })
})

describe("postgresProvider.validate", () => {
  it("S2-01: single valide", () => {
    expect(() => postgresProvider.validate(cfg({}))).not.toThrow()
  })

  it("refuse un moteur inattendu", () => {
    expect(() => postgresProvider.validate(cfg({ engine: "redis" }))).toThrow(
      DatabaseValidationError
    )
  })

  it("HA valide (replicas 3, consensus par défaut)", () => {
    expect(() =>
      postgresProvider.validate(
        cfg({ mode: "ha", topology: { replicas: 3 } })
      )
    ).not.toThrow()
  })

  it("HA : replicas hors [3,5,7] rejeté, pas de mutation", () => {
    expect(() =>
      postgresProvider.validate(cfg({ mode: "ha", topology: { replicas: 2 } }))
    ).toThrow(DatabaseValidationError)
  })

  it("consensusReplicas interdit en single", () => {
    expect(() =>
      postgresProvider.validate(
        cfg({ topology: { replicas: 1, consensusReplicas: 3 } })
      )
    ).toThrow(DatabaseValidationError)
  })

  it("S2-03: pas de mutation silencieuse - single hors replicas=1 rejeté", () => {
    // Contourné par validateDatabaseConfig (replicas hors [1] en single).
    expect(() => postgresProvider.validate(cfg({ topology: { replicas: 2 } }))).toThrow(
      DatabaseValidationError
    )
    // Et défendu au expand, second rideau.
    expect(() => expandPostgres(cfg({ topology: { replicas: 2 } }), ctx)).toThrow(
      /replicas=1/
    )
  })
})

describe("expandPostgres single (S2-04)", () => {
  it("3 ressources : 1 conteneur + 1 réseau + 1 volume data", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(exp.resources).toHaveLength(3)
    const kinds = exp.resources.map((r) => r.kind).sort()
    expect(kinds).toEqual(["container", "network", "volume"])
    const volume = exp.resources.find((r) => r.kind === "volume")!
    expect(volume.data).toBe(true)
  })

  it("noms boz_<slug>_<node> cohérents", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(postgresMemberServiceName(ctx)).toBe("boz_proj-a_catalog")
    expect(containerOf(exp).name).toBe("catalog")
    const network = exp.resources.find((r) => r.kind === "network")!
    const volume = exp.resources.find((r) => r.kind === "volume")!
    expect(network.name).toBe("catalog-net")
    expect(volume.name).toBe("catalog-data")
  })

  it("nodeIds synthétiques db::<parent>::<role>::<index>", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const ids = exp.resources.map((r) => r.nodeId)
    expect(ids).toContain("db::n_db_01::member::0")
    expect(ids).toContain("db::n_db_01::network::0")
    expect(ids).toContain("db::n_db_01::volume::0")
  })

  it("edges : membre→réseau et membre→volume (mount pg data)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(exp.edges).toHaveLength(2)
    const net = exp.edges.find((e) => e.kind === "network")
    const vol = exp.edges.find((e) => e.kind === "volume")
    expect(net?.source).toBe("db::n_db_01::member::0")
    expect(net?.target).toBe("db::n_db_01::network::0")
    expect(vol?.source).toBe("db::n_db_01::member::0")
    expect(vol?.target).toBe("db::n_db_01::volume::0")
    expect(vol?.config?.mountPath).toBe("/var/lib/postgresql/data")
  })

  it("S2-06: healthcheck pg_isready - forme exec, sans shell", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const hc = containerOf(exp).config.healthcheck
    expect(hc).toBeDefined()
    const test = (hc as { test: string[] }).test
    expect(test).toEqual(["CMD", "pg_isready", "-U", "catalog", "-d", "catalog_db"])
  })

  it("config membre round-trip via ContainerConfigSchema (parseNodeConfig OK)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const parsed = ContainerConfigSchema.parse(containerOf(exp).config)
    expect(parsed.image).toBe("postgres")
    expect(parsed.tag).toBe("16.3")
  })

  it("S2-07: ressources par défaut appliquées quand absentes", () => {
    const exp = expandPostgres(
      cfg({ resources: undefined }),
      ctx
    )
    const c = containerOf(exp).config
    expect(c.resources).toEqual({ cpus: 0.5, memMb: 512 })
  })

  it("ressources explicites conservées", () => {
    const exp = expandPostgres(cfg({ resources: { cpus: 2, memMb: 2048 } }), ctx)
    expect(containerOf(exp).config.resources).toEqual({ cpus: 2, memMb: 2048 })
  })

  it("secret référencé, jamais la valeur : env exacte + secrets[]", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const c = containerOf(exp).config
    expect(c.secrets).toEqual([{ secretName: "db_catalog_secret" }])
    // Env EXACTE : rien d'autre ne peut s'y glisser (aucune valeur de secret).
    expect(c.env).toEqual({
      POSTGRES_USER: "catalog",
      POSTGRES_DB: "catalog_db",
      POSTGRES_PASSWORD_FILE: "/run/secrets/db_catalog_secret",
    })
  })

  it("contrat nommage : host === boz_<slug>_<resourceName>", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const member = containerOf(exp)
    expect(postgresMemberServiceName(ctx)).toBe(`boz_proj-a_${member.name}`)
  })

  it("volume data : driver/driverOpts/external transmis", () => {
    const exp = expandPostgres(
      cfg({
        storage: {
          driver: "rbd",
          driverOpts: { size: "20" },
          external: true,
          externalName: "catacloud_db",
        },
      }),
      ctx
    )
    const v = exp.resources.find((r) => r.kind === "volume")!
    expect(v.config.driver).toBe("rbd")
    expect(v.config.driverOpts).toEqual({ size: "20" })
    expect(v.config.external).toBe(true)
    expect(v.config.externalName).toBe("catacloud_db")
  })

  it("S2-11: aucun secret généré, aucun état (expansion pure)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(exp.generatedSecrets).toEqual([])
  })

  it("S2-05: déterminisme - 10 expansions identiques", () => {
    const first = JSON.stringify(expandPostgres(cfg({}), ctx))
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(expandPostgres(cfg({}), ctx))).toBe(first)
    }
  })

  it("S2-09: contract de connexion single (writer)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(exp.connections).toHaveLength(1)
    const conn = exp.connections[0]!
    expect(conn.role).toBe("writer")
    expect(conn.host).toBe("boz_proj-a_catalog")
    expect(conn.port).toBe(5432)
    expect(conn.database).toBe("catalog_db")
    expect(conn.username).toBe("catalog")
    expect(conn.passwordSecretRef).toBe("db_catalog_secret")
    // Env de connexion EXACTE : l'app reçoit les morceaux, jamais la valeur.
    expect(conn.env).toEqual({
      DATABASE_HOST: "boz_proj-a_catalog",
      DATABASE_PORT: "5432",
      DATABASE_USER: "catalog",
      DATABASE_NAME: "catalog_db",
      DATABASE_CREDENTIALS_FILE: "/run/secrets/db_catalog_secret",
    })
  })
})

describe("expandPostgres single - moteur non postgres", () => {
  it("refuse un moteur inattendu", () => {
    expect(() => expandPostgres(cfg({ engine: "mysql" }), ctx)).toThrow(
      DatabaseValidationError
    )
  })
})