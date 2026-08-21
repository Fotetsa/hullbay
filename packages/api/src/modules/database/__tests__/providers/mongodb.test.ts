import { describe, it, expect } from "vitest"
import { ContainerConfigSchema } from "@hullbay/shared"
import type { DatabaseConfig } from "@hullbay/shared"
import { expandMongo, mongoProvider, mongoConnections } from "../../providers/mongodb.js"
import {
  DATABASE_PROVIDERS,
  getDatabaseProvider,
} from "../../providers/index.js"
import type { ExpansionContext, GeneratedResource } from "../../types.js"

const ctx: ExpansionContext = {
  parentNodeId: "n_db_mongo_01",
  projectSlug: "proj-a",
  parentNode: {
    id: "n_db_mongo_01",
    name: "content",
    type: "database",
    config: {
      engine: "mongodb",
      version: "7.0",
      mode: "single",
      topology: { replicas: 1 },
      storage: { driver: "local", driverOpts: {}, external: false },
      credentials: {
        username: "content_app",
        passwordSecretRef: "db_content_secret",
        database: "content_db",
      },
      retainDataOnDelete: true,
    },
  },
}

const HA_REPLICAS = 3

function cfg(overrides: Partial<DatabaseConfig>): DatabaseConfig {
  return {
    ...ctx.parentNode.config,
    mode: "ha",
    topology: { replicas: HA_REPLICAS },
    ...overrides,
  }
}

function containers(exp: ReturnType<typeof expandMongo>) {
  return exp.resources.filter((r): r is GeneratedResource & { kind: "container" } => r.kind === "container")
}
function byRole(exp: ReturnType<typeof expandMongo>, role: string) {
  return containers(exp).filter((r) => r.role === role)
}
function volumes(exp: ReturnType<typeof expandMongo>) {
  return exp.resources.filter((r): r is GeneratedResource & { kind: "volume" } => r.kind === "volume")
}

describe("mongodbProvider - registry (S7)", () => {
  it("mongodb enregistré dans DATABASE_PROVIDERS / getDatabaseProvider", () => {
    expect(getDatabaseProvider("mongodb")).toBe(mongoProvider)
    expect(DATABASE_PROVIDERS.mongodb?.engine).toBe("mongodb")
  })
})

describe("mongodbProvider.validate (S7)", () => {
  it("single valide", () => {
    expect(() => mongoProvider.validate(ctx.parentNode.config)).not.toThrow()
  })

  it("refuse un moteur inattendu", () => {
    expect(() => mongoProvider.validate(cfg({ engine: "postgres" }))).toThrow(/moteur/)
  })

  it("S7-09 : external + HA rejeté (même volume partagé = corruption)", () => {
    expect(() =>
      mongoProvider.validate(
        cfg({ storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext" } })
      )
    ).toThrow(/volume externe non supporté en HA/)
  })

  it("S7-09 : volume externe accepté en single", () => {
    expect(() =>
      mongoProvider.validate({
        ...cfg({}),
        mode: "single",
        topology: { replicas: 1 },
        storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext" },
      })
    ).not.toThrow()
  })
})

describe("expandMongo single (S7)", () => {
  it("inventaire : membre + réseau + volume data", () => {
    const exp = expandMongo(ctx.parentNode.config, ctx)
    expect(byRole(exp, "member")).toHaveLength(1)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
    const vols = volumes(exp)
    expect(vols).toHaveLength(1)
    expect(vols[0]!.data).toBe(true)
    expect(exp.connections).toEqual(mongoConnections(ctx.parentNode.config, ctx))
  })

  it("membre : env root (_FILE) sans mot de passe, secret référencé monté", () => {
    const exp = expandMongo(ctx.parentNode.config, ctx)
    const member = byRole(exp, "member")[0]!
    const env = member.config.env as Record<string, string>
    expect(env.MONGO_INITDB_ROOT_USERNAME).toBe("content_app")
    expect(env.MONGO_INITDB_ROOT_PASSWORD_FILE).toBe("/run/secrets/db_content_secret")
    expect(env.MONGO_INITDB_DATABASE).toBe("content_db")
    const secretNames = member.config.secrets!.map((s) => s.secretName)
    expect(secretNames).toContain("db_content_secret")
    expect(secretNames).toHaveLength(1)
    expect(Object.values(env).join(" ")).not.toMatch(/[0-9a-f]{24}/)
  })

  it("version du contrat appliquée au tag image", () => {
    const exp = expandMongo({ ...ctx.parentNode.config, version: "7.0" }, ctx)
    const member = byRole(exp, "member")[0]!
    expect(member.config.image).toBe("mongo")
    expect(member.config.tag).toBe("7.0")
  })

  it("healthcheck membre : mongosh + secret lu au runtime sans -p argv", () => {
    const exp = expandMongo(ctx.parentNode.config, ctx)
    const member = byRole(exp, "member")[0]!
    expect(member.config.healthcheck).toBeDefined()
    const test = member.config.healthcheck!.test.join(" ")
    expect(test).toContain("mongosh")
    // Auth DANS l'éval (cat du fichier) — jamais de -p argv (visible ps, §23).
    expect(test).toContain('cat("/run/secrets/db_content_secret")')
    expect(test).not.toMatch(/-p "/)
    expect(test).toContain("db.adminCommand({ping:1})")
  })

  it("roundtrip ContainerConfigSchema sur chaque ressource générée", () => {
    const exp = expandMongo(ctx.parentNode.config, ctx)
    for (const c of containers(exp)) {
      expect(() => ContainerConfigSchema.parse(c.config)).not.toThrow()
    }
  })

  it("single : pas de generatedSecrets (pas de keyfile nécessaire)", () => {
    const exp = expandMongo(ctx.parentNode.config, ctx)
    expect(exp.generatedSecrets).toHaveLength(0)
  })
})

describe("expandMongo HA replica set (S7 §15)", () => {
  it("inventaire : 3 membres + réseau + 3 volumes data — PAS de proxy", () => {
    const exp = expandMongo(cfg({}), ctx)
    expect(byRole(exp, "member")).toHaveLength(HA_REPLICAS)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
    expect(volumes(exp).filter((v) => v.data)).toHaveLength(HA_REPLICAS)
    expect(containers(exp)).toHaveLength(HA_REPLICAS)
  })

  it("un service par membre : DNS boz_<slug>_<db>-<i>, replicas=1", () => {
    const exp = expandMongo(cfg({}), ctx)
    const members = byRole(exp, "member")
    expect(members.map((m) => m.name)).toEqual(["content-1", "content-2", "content-3"])
    expect(members.every((m) => m.config.replicas === 1)).toBe(true)
  })

  it("cmd wrapper : keyfile copiée + chmod 600, chan mongod --replSet", () => {
    const exp = expandMongo(cfg({}), ctx)
    const members = byRole(exp, "member")
    for (const m of members) {
      const cmd = m.config.cmd!.join("\n")
      expect(cmd).toContain("cp /run/secrets/content-mongo-keyfile-")
      expect(cmd).toContain("chmod 600 /tmp/mongo-keyfile")
      expect(cmd).toContain("--replSet rs_content_")
      expect(cmd).toContain("--keyFile /tmp/mongo-keyfile")
    }
    // Noms de RS cohérents (déterministes) entre membres.
    const rs0 = members[0]!.config.cmd!.find((c) => c.startsWith("--replSet"))!
    const rs1 = members[1]!.config.cmd!.find((c) => c.startsWith("--replSet"))!
    expect(rs0).toBe(rs1)
  })

  it("S7-14 : seed = init RS post-démarrage (mongosh 127.0.0.1, auth root) ; non-seed = entrypoint direct", () => {
    const exp = expandMongo(cfg({}), ctx)
    const init = exp.generatedSecrets.find((s) => s.name.includes("mongo-rs-init-"))!
    const members = byRole(exp, "member")

    // Seed : wrapper complet — entrypoint en arrière-plan, attente UP mongod,
    // init JS joué depuis localhost (pas /docker-entrypoint-initdb.d/).
    const seed = members[0]!.config.cmd!.join("\n")
    expect(seed).toContain("docker-entrypoint.sh mongod")
    expect(seed).toContain("MONGOD_PID=$!")
    expect(seed).toContain("tries=60")
    expect(seed).toContain("127.0.0.1")
    expect(seed).toContain(`< /run/secrets/${init.name}`)
    expect(seed).toContain('db.hello().ok')
    expect(seed).toContain('wait "$MONGOD_PID"')
    expect(seed).not.toContain("docker-entrypoint-initdb.d")

    // Non-seed : entrée entrypoint classique, pas d'init RS, pas de secret d'init.
    for (const m of members.slice(1)) {
      const cmd = m.config.cmd!.join("\n")
      expect(cmd).toContain("exec docker-entrypoint.sh mongod")
      expect(cmd).not.toContain("MONGOD_PID")
      expect(cmd).not.toContain("127.0.0.1")
    }
  })

  it("config-secrets : keyfile partagée + script d'init RS (seed seul le monte)", () => {
    const exp = expandMongo(cfg({}), ctx)
    const key = exp.generatedSecrets.find((s) => s.name.includes("mongo-keyfile-"))!
    expect(key).toBeDefined()
    expect(key.data).toMatch(/^[0-9a-f]{24}$/)
    const init = exp.generatedSecrets.find((s) => s.name.includes("mongo-rs-init-"))!
    expect(init).toBeDefined()
    expect(init.data).toContain("rs.initiate")
    expect(init.data).toContain("priority: 3")
    expect(init.data).toContain("content-1:27017")
    expect(init.data).toContain("content-2:27017")
    expect(init.data).toContain("content-3:27017")

    // Seed (membre 0) monte le script d'init ; les autres non.
    const members = byRole(exp, "member")
    const seedNames = members[0]!.config.secrets!.map((s) => s.secretName)
    const nonSeed = members.filter((_, i) => i !== 0)
    expect(seedNames).toContain(init.name)
    for (const m of nonSeed) {
      expect(m.config.secrets!.some((s) => s.secretName.includes("mongo-rs-init-"))).toBe(false)
    }
    // Tous montent la keyfile + le secret applicatif.
    for (const m of members) {
      const names = m.config.secrets!.map((s) => s.secretName)
      expect(names.filter((n) => n.includes("mongo-keyfile-"))).toHaveLength(1)
      expect(names).toContain("db_content_secret")
    }
  })

  it("healthcheck membre HA : présence RS (PRIMARY/SECONDARY)", () => {
    const exp = expandMongo(cfg({}), ctx)
    for (const m of byRole(exp, "member")) {
      const test = m.config.healthcheck!.test.join(" ")
      expect(test).toContain("db.hello()")
      expect(test).toContain("isWritablePrimary")
      expect(test).toContain("secondary")
    }
  })

  it("connections : DATABASE_URL RS-aware (spec §15), hosts <db>-<i>, PAS de VIP", () => {
    const exp = expandMongo(cfg({}), ctx)
    const conns = exp.connections
    expect(conns).toHaveLength(1)
    const w = conns[0]!
    expect(w.role).toBe("writer")
    expect(w.host).toBe("boz_proj-a_content-1")
    expect(w.port).toBe(27017)
    const url = w.env.DATABASE_URL!
    expect(url).toContain("mongodb://boz_proj-a_content-1:27017,boz_proj-a_content-2:27017,boz_proj-a_content-3:27017/")
    expect(url).toMatch(/content_db\?replicaSet=rs_content_/)
    expect(url).toContain("authSource=admin")
    expect(w.env).toMatchObject({
      DATABASE_HOST: "boz_proj-a_content-1",
      DATABASE_PORT: "27017",
      DATABASE_USER: "content_app",
      DATABASE_NAME: "content_db",
      DATABASE_CREDENTIALS_FILE: "/run/secrets/db_content_secret",
      DATABASE_SCHEME: "mongodb",
    })
    expect(w.env.DATABASE_REPLICA_SET).toMatch(/^rs_content_[0-9a-f]{8}$/)
    expect(exp.connections).toEqual(mongoConnections(cfg({}), ctx))
  })

  it("placement membres : spread node.id, sans contrainte worker (mono-nœud)", () => {
    const exp = expandMongo(cfg({}), ctx)
    for (const m of byRole(exp, "member")) {
      const placement = m.config.placement as { constraints?: string[] } | undefined
      expect(placement?.constraints ?? []).not.toContain("node.role==worker")
    }
  })

  it("S7-13 : déterminisme — 10 expansions identiques", () => {
    const first = JSON.stringify(expandMongo(cfg({}), ctx))
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(expandMongo(cfg({}), ctx))).toBe(first)
    }
  })

  it("expansion pure : rien n'est muté entre deux appels", () => {
    const a = expandMongo(cfg({}), ctx)
    const snapshot = JSON.stringify(a)
    expandMongo(cfg({}), ctx)
    expect(JSON.stringify(a)).toBe(snapshot)
  })

  it("roundtrip ContainerConfigSchema sur chaque conteneur généré (HA)", () => {
    const exp = expandMongo(cfg({}), ctx)
    for (const c of containers(exp)) {
      expect(() => ContainerConfigSchema.parse(c.config)).not.toThrow()
    }
  })
})