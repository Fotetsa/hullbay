import { describe, it, expect } from "vitest"
import { parseNodeConfig, computeDesiredHash, type ProjectGraph, type DatabaseConfig, type DatabaseEngine } from "@hullbay/shared"
import { expandDatabaseGraph } from "../expansion.js"
import { DatabaseValidationError } from "../validation.js"

const dbNode = {
  id: "n_db",
  projectId: "p1",
  type: "database" as const,
  name: "catalog",
  posX: 100,
  posY: 120,
  config: {
    engine: "postgres",
    version: "16.3",
    mode: "single",
    topology: { replicas: 1 },
    storage: { sizeGb: 20 },
    credentials: { username: "app", passwordSecretRef: "db_pg_password", database: "app" },
    retainDataOnDelete: true,
  },
}

const appNode = {
  id: "n_app",
  projectId: "p1",
  type: "container" as const,
  name: "web",
  posX: 0,
  posY: 0,
  config: { image: "nginx", tag: "1.27", env: { PORT: "8080" }, replicas: 2 },
}

function baseGraph(extraEdges: ProjectGraph["edges"]): ProjectGraph {
  return {
    id: "p1",
    name: "projet A",
    slug: "proj-a",
    clusterId: "c1",
    status: "draft",
    nodes: [dbNode, appNode],
    edges: extraEdges,
  }
}

describe("expandDatabaseGraph (S3-01)", () => {
  it("génère les ressources du provider et retire le nœud database", () => {
    const expanded = expandDatabaseGraph(baseGraph([]))
    const nodes = expanded.graph.nodes
    expect(nodes.find((n) => n.id === "n_db")).toBeUndefined()
    expect(nodes).toHaveLength(4) // app + membre + réseau + volume
    expect(nodes.find((n) => n.id === "db::n_db::member::0")?.type).toBe("container")
    expect(nodes.find((n) => n.id === "db::n_db::network::0")?.type).toBe("network")
    expect(nodes.find((n) => n.id === "db::n_db::volume::0")?.type).toBe("volume")
  })

  it("S3-12: members jamais persistés — ressources en mémoire uniquement", () => {
    const expanded = expandDatabaseGraph(baseGraph([]))
    // Le graphe déployable ne contient AUCUN nœud de composition `database`
    // (jamais de ressource runtime) ; les membres générés portent des nodeIds
    // synthétiques `db::<parent>::…` distincts des nœuds persistés `n_*`.
    const persisted = expanded.graph.nodes.filter((n) => n.id.startsWith("n_"))
    expect(expanded.graph.nodes.some((n) => n.type === "database")).toBe(false)
    const synthetic = expanded.graph.nodes.filter((n) => n.id.startsWith("db::"))
    expect(synthetic.length).toBeGreaterThan(0)
    for (const n of synthetic) {
      expect(expanded.ownership.has(n.id)).toBe(true)
    }
    expect(expanded.graph.nodes).toHaveLength(persisted.length + synthetic.length)
  })

  it("ownership par ressource générée (labels bozando.database.*)", () => {
    const expanded = expandDatabaseGraph(baseGraph([]))
    const own = expanded.ownership.get("db::n_db::member::0")!
    expect(own.parentNodeId).toBe("n_db")
    expect(own.role).toBe("member")
    expect(own.index).toBe(0)
    expect(own.engine).toBe("postgres")
    const volOwn = expanded.ownership.get("db::n_db::volume::0")!
    expect(volOwn.data).toBe(true)
  })

  it("edges internes générés (member→network, member→volume)", () => {
    const expanded = expandDatabaseGraph(baseGraph([]))
    expect(expanded.graph.edges).toHaveLength(2)
    expect(expanded.graph.edges.some((e) => e.kind === "network")).toBe(true)
    expect(expanded.graph.edges.some((e) => e.kind === "volume")).toBe(true)
  })

  it("permet le roundtrip parseNodeConfig sur chaque ressource générée", () => {
    const expanded = expandDatabaseGraph(baseGraph([]))
    for (const n of expanded.graph.nodes) {
      expect(() => parseNodeConfig(n.type, n.config)).not.toThrow()
    }
  })
})

describe("expandDatabaseGraph — edge app→db (S3-06)", () => {
  it("injecte l'env de connexion dans le conteneur applicatif", () => {
    const expanded = expandDatabaseGraph(
      baseGraph([
        {
          id: "e1",
          projectId: "p1",
          sourceNodeId: "n_app",
          targetNodeId: "n_db",
          kind: "database",
        },
      ])
    )
    const app = expanded.graph.nodes.find((n) => n.id === "n_app")!
    const env = (app.config as { env: Record<string, string> }).env
    expect(env.DATABASE_HOST).toBe("boz_proj-a_catalog")
    expect(env.DATABASE_CREDENTIALS_FILE).toBe("/run/secrets/db_pg_password")
    expect(env.PORT).toBe("8080") // env d'origine conservée
  })

  it("S5-11: monte le secret provider dans l'app dépendante (secrets[])", () => {
    const expanded = expandDatabaseGraph(
      baseGraph([
        {
          id: "e1",
          projectId: "p1",
          sourceNodeId: "n_app",
          targetNodeId: "n_db",
          kind: "database" as const,
        },
      ])
    )
    // L'app lit le mot de passe via DATABASE_CREDENTIALS_FILE : le secret référencé
    // doit être MONTÉ dans le conteneur, sinon /run/secrets/<ref> n'existe pas.
    const app = expanded.graph.nodes.find((n) => n.id === "n_app")!
    const secrets = (app.config as { secrets: { secretName: string }[] }).secrets
    expect(secrets.some((s) => s.secretName === "db_pg_password")).toBe(true)
  })

  it("ne duplique pas un secret déjà monté par l'app", () => {
    const appWithSecret = {
      ...appNode,
      config: { ...appNode.config, secrets: [{ secretName: "db_pg_password" }] },
    }
    const graph: ProjectGraph = {
      ...baseGraph([]),
      nodes: [dbNode, appWithSecret],
      edges: [
        {
          id: "e1",
          projectId: "p1",
          sourceNodeId: "n_app",
          targetNodeId: "n_db",
          kind: "database" as const,
        },
      ],
    }
    const expanded = expandDatabaseGraph(graph)
    const app = expanded.graph.nodes.find((n) => n.id === "n_app")!
    const secrets = (app.config as { secrets: { secretName: string }[] }).secrets
    expect(secrets.filter((s) => s.secretName === "db_pg_password")).toHaveLength(1)
  })

  it("ajoute un edge réseau app→réseau DB (résolution DNS Swarm)", () => {
    const expanded = expandDatabaseGraph(
      baseGraph([
        {
          id: "e1",
          projectId: "p1",
          sourceNodeId: "n_app",
          targetNodeId: "n_db",
          kind: "database",
        },
      ])
    )
    const dbNet = expanded.ownership.get("db::n_db::network::0")!
    expect(dbNet).toBeDefined()
    const netEdge = expanded.graph.edges.find(
      (e) => e.sourceNodeId === "n_app" && e.kind === "network"
    )
    expect(netEdge?.targetNodeId).toBe("db::n_db::network::0")
  })

  it("S3-07: l'app garde un hash déterminé par l'env injectée", () => {
    const dbEdge = {
      id: "e1",
      projectId: "p1",
      sourceNodeId: "n_app",
      targetNodeId: "n_db",
      kind: "database" as const,
    }
    // Avec edge database → l'env DATABASE_HOST change le hash de l'app.
    const withConn = expandDatabaseGraph(
      baseGraph([{ ...dbEdge }])
    )
    const app = withConn.graph.nodes.find((n) => n.id === "n_app")!
    const appHash = (nodes: ReturnType<typeof expandDatabaseGraph>["graph"]["nodes"]) => {
      const n = nodes.find((x) => x.id === "n_app")!
      return computeDesiredHash({ type: n.type, name: n.name, config: n.config })
    }
    const hashA = appHash(withConn.graph.nodes)
    // Sans edge database → aucune env injectée → hash différent.
    const withoutConn = expandDatabaseGraph(baseGraph([]))
    const hashB = appHash(withoutConn.graph.nodes)
    expect(hashA).not.toBe(hashB)
    // Et l'expansion reste déterministe : le même graphe → même hash.
    expect(
      appHash(expandDatabaseGraph(baseGraph([{ ...dbEdge }])).graph.nodes)
    ).toBe(hashA)
  })

  it("multi-bases : l'edge app→dbB cible la BONNE base (pas la première)", () => {
    const dbB = {
      ...dbNode,
      id: "n_dbB",
      name: "analytics",
      config: {
        ...dbNode.config,
        credentials: { username: "report", passwordSecretRef: "db_report", database: "report" },
      },
    }
    const graph: ProjectGraph = {
      ...baseGraph([]),
      nodes: [dbNode, dbB, appNode],
      edges: [
        {
          id: "e1",
          projectId: "p1",
          sourceNodeId: "n_app",
          targetNodeId: "n_dbB",
          kind: "database",
        },
      ],
    }
    const expanded = expandDatabaseGraph(graph)
    const app = expanded.graph.nodes.find((n) => n.id === "n_app")!
    const env = (app.config as { env: Record<string, string> }).env
    // DATABASE_HOST = ressource du membre de n_dbB, pas n_db.
    expect(env.DATABASE_HOST).toBe("boz_proj-a_analytics")
    expect(env.DATABASE_CREDENTIALS_FILE).toBe("/run/secrets/db_report")
    // Edge réseau = vers le réseau de n_dbB.
    const netEdge = expanded.graph.edges.find(
      (e) => e.sourceNodeId === "n_app" && e.kind === "network"
    )
    expect(expanded.ownership.get(netEdge!.targetNodeId)?.parentNodeId).toBe("n_dbB")
  })
})

describe("expandDatabaseGraph — déterminisme et modes", () => {
  /** Config database single valide par moteur (même forme que les fixtures providers). */
  const engineConfigs = {
    postgres: { ...dbNode.config, engine: "postgres", version: "16.3" },
    mysql: { ...dbNode.config, engine: "mysql", version: "8.4" },
    mongodb: { ...dbNode.config, engine: "mongodb", version: "7.0" },
    redis: { ...dbNode.config, engine: "redis", version: "7.2-alpine" },
  } as unknown as Record<DatabaseEngine, DatabaseConfig>

  it("10 expansions strictement identiques", () => {
    const ref = JSON.stringify(expandDatabaseGraph(baseGraph([])))
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(expandDatabaseGraph(baseGraph([])))).toBe(ref)
    }
  })

  it("S10-01: déterminisme 10 appels sur les 4 moteurs (sorties strictement identiques)", () => {
    for (const [engine, cfg] of Object.entries(engineConfigs)) {
      const base = baseGraph([])
      const graph: ProjectGraph = {
        ...base,
        nodes: base.nodes.map((n) => (n.id === "n_db" ? { ...n, config: cfg } : n)),
      }
      const ref = JSON.stringify(expandDatabaseGraph(graph))
      for (let i = 0; i < 10; i++) {
        const cloned: ProjectGraph = {
          ...baseGraph([]),
          nodes: baseGraph([]).nodes.map((n) => (n.id === "n_db" ? { ...n, config: cfg } : n)),
        }
        expect(JSON.stringify(expandDatabaseGraph(cloned))).toBe(ref)
      }
    }
  })

  it("NE MUTE JAMAIS le graphe d'entrée (l'env injectée ne fuit pas entre appels)", () => {
    const dbEdge = {
      id: "e1",
      projectId: "p1",
      sourceNodeId: "n_app",
      targetNodeId: "n_db",
      kind: "database" as const,
    }
    const fresh = baseGraph([{ ...dbEdge }])
    const snapshot = JSON.stringify(fresh.nodes)
    const first = expandDatabaseGraph(fresh)
    const second = expandDatabaseGraph(fresh)
    // L'entrée est intacte après expansion…
    expect(JSON.stringify(fresh.nodes)).toBe(snapshot)
    // …et deux expansions successives du MÊME objet sont identiques (env
    // ré-injectée proprement, pas de DATABASE_HOST résiduel sans edge).
    expect(JSON.stringify(first.graph.nodes)).toBe(JSON.stringify(second.graph.nodes))
    const withoutEdge = expandDatabaseGraph(baseGraph([]))
    const appNoConn = withoutEdge.graph.nodes.find((n) => n.id === "n_app")!
    const env = (appNoConn.config as { env: Record<string, string> }).env
    expect(env.DATABASE_HOST).toBeUndefined()
  })

  it("strict=true : redis (S8) expandé → resources générées, nœud DB retiré", () => {
    const redisDb = {
      ...dbNode,
      name: "cache",
      config: {
        ...dbNode.config,
        engine: "redis" as const,
        mode: "ha" as const,
        topology: { replicas: 2 },
        credentials: { username: "app", passwordSecretRef: "db_redis", database: "app" },
      },
    }
    const graph = { ...baseGraph([]), nodes: [redisDb, appNode] }
    const expanded = expandDatabaseGraph(graph)
    // 2 data members + 3 sentinels + réseau + 2 volumes.
    expect(expanded.graph.nodes).toHaveLength(
      graph.nodes.length - 1 + 2 + 3 + 1 + 2
    )
    expect(expanded.graph.nodes.some((n) => n.type === "database")).toBe(false)
    expect(expanded.graph.nodes.some((n) => n.name === "cache-1")).toBe(true)
    expect(expanded.graph.nodes.some((n) => n.name === "cache-sentinel-1")).toBe(true)
  })

  it("strict=false (plan/destroy) : redis expandé aussi (tous les moteurs implémentés)", () => {
    const redisDb = {
      ...dbNode,
      name: "cache",
      config: {
        ...dbNode.config,
        engine: "redis" as const,
        mode: "ha" as const,
        topology: { replicas: 2 },
        credentials: { username: "app", passwordSecretRef: "db_redis", database: "app" },
      },
    }
    const graph = { ...baseGraph([]), nodes: [redisDb, appNode] }
    const expanded = expandDatabaseGraph(graph, { strict: false })
    expect(expanded.graph.nodes.some((n) => n.name === "cache-sentinel-1")).toBe(true)
    expect(expanded.ownership.size).toBeGreaterThan(0)
  })

  it("edge kind database retiré du graphe déployable (traité par env+réseau)", () => {
    const expanded = expandDatabaseGraph(
      baseGraph([
        {
          id: "e1",
          projectId: "p1",
          sourceNodeId: "n_app",
          targetNodeId: "n_db",
          kind: "database",
        },
      ])
    )
    expect(expanded.graph.edges.some((e) => e.kind === "database")).toBe(false)
  })
})

describe("expandDatabaseGraph — config invalide", () => {
  it("topologie invalide bloquée avant toute génération (pas de mutation)", () => {
    const bad = {
      ...dbNode,
      config: { ...dbNode.config, mode: "ha", topology: { replicas: 2 } },
    }
    const graph = { ...baseGraph([]), nodes: [bad, appNode] }
    expect(() => expandDatabaseGraph(graph)).toThrow(DatabaseValidationError)
  })
})