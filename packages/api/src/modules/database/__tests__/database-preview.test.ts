import { describe, it, expect } from "vitest"
import type { ProjectGraph } from "@hullbay/shared"
import { databaseNodePreview } from "../expansion.js"

const singleDb = {
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

const haDb = {
  ...singleDb,
  id: "n_db_ha",
  name: "catalog-ha",
  config: {
    ...singleDb.config,
    mode: "ha",
    topology: { replicas: 3 },
  },
}

function graph(nodes: ProjectGraph["nodes"]): ProjectGraph {
  return {
    id: "p1",
    name: "projet A",
    slug: "proj-a",
    clusterId: "c1",
    status: "draft",
    nodes,
    edges: [],
  }
}

describe("databaseNodePreview (S5-09/10)", () => {
  it("single : 1 membre + réseau + volume + endpoint writer", () => {
    const preview = databaseNodePreview(graph([singleDb]), "n_db")!
    expect(preview).not.toBeNull()
    expect(preview.resources.map((r) => r.name).sort()).toEqual([
      "catalog",
      "catalog-data",
      "catalog-net",
    ])
    expect(preview.connections).toHaveLength(1)
    expect(preview.connections[0]!.role).toBe("writer")
    expect(preview.connections[0]!.host).toBe("boz_proj-a_catalog")
  })

  it("HA : 3 membres + 3 etcd + writer + reader + réseau + 6 volumes", () => {
    const preview = databaseNodePreview(graph([haDb]), "n_db_ha")!
    const roles = preview.resources.map((r) => r.role)
    expect(roles).toEqual(
      expect.arrayContaining(["member", "consensus", "writer", "reader", "network", "volume"]),
    )
    expect(roles.filter((r) => r === "member")).toHaveLength(3)
    expect(roles.filter((r) => r === "consensus")).toHaveLength(3)
    expect(preview.connections).toHaveLength(2)
    const [writer, reader] = preview.connections
    expect(writer!.role).toBe("writer")
    expect(reader!.role).toBe("reader")
    expect(writer!.host).toBe("boz_proj-a_catalog-ha-writer")
    expect(reader!.host).toBe("boz_proj-a_catalog-ha-reader")
  })

  it("nœud non-database → null", () => {
    const other = { ...singleDb, id: "n_app", type: "container" as const }
    expect(databaseNodePreview(graph([other]), "n_app")).toBeNull()
  })

  it("redis : préview complète (S8)", () => {
    const redis = {
      ...singleDb,
      id: "n_redis",
      config: {
        ...singleDb.config,
        engine: "redis",
        topology: { replicas: 1 },
      },
    }
    const preview = databaseNodePreview(graph([redis as typeof singleDb]), "n_redis")!
    expect(preview.resources.length).toBeGreaterThan(0)
    expect(preview.connections).toHaveLength(1)
    expect(preview.connections[0]!.env.DATABASE_SCHEME).toBe("redis")
  })

  it("deterministe : deux appels identiques", () => {
    const g = graph([haDb])
    expect(databaseNodePreview(g, "n_db_ha")).toEqual(databaseNodePreview(g, "n_db_ha"))
  })
})