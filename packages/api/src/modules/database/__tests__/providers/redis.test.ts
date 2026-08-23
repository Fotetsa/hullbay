import { describe, it, expect } from "vitest"
import { ContainerConfigSchema } from "@hullbay/shared"
import type { DatabaseConfig } from "@hullbay/shared"
import { expandRedis, redisProvider } from "../../providers/redis.js"
import { getDatabaseProvider } from "../../providers/index.js"
import type { ExpansionContext, GeneratedResource } from "../../types.js"

const ctx: ExpansionContext = {
  parentNodeId: "n_db_redis_01",
  projectSlug: "proj-a",
  parentNode: {
    id: "n_db_redis_01",
    name: "cache",
    type: "database",
    config: {
      engine: "redis",
      version: "7.2-alpine",
      mode: "single",
      topology: { replicas: 1 },
      storage: { driver: "local", driverOpts: {}, external: false },
      credentials: {
        username: "app",
        passwordSecretRef: "db_redis",
        database: "app",
      },
      retainDataOnDelete: true,
    },
  },
}

function cfg(overrides: Partial<DatabaseConfig>): DatabaseConfig {
  return {
    ...ctx.parentNode.config,
    mode: "ha",
    topology: { replicas: 2, consensusReplicas: undefined },
    ...overrides,
  }
}

function containers(exp: ReturnType<typeof expandRedis>) {
  return exp.resources.filter((r): r is GeneratedResource & { kind: "container" } => r.kind === "container")
}
function byRole(exp: ReturnType<typeof expandRedis>, role: string) {
  return containers(exp).filter((r) => r.role === role)
}

describe("expandRedis single (S8-01)", () => {
  it("inventaire : 1 membre + volume data + réseau + edges", () => {
    const exp = expandRedis(cfg({ mode: "single", topology: { replicas: 1 } }), ctx)
    expect(byRole(exp, "member")).toHaveLength(1)
    const vols = exp.resources.filter((r) => r.kind === "volume")
    expect(vols).toHaveLength(1)
    expect(vols[0]!.data).toBe(true)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
    expect(exp.edges).toHaveLength(2)
    expect(exp.edges).toContainEqual({ source: "db::n_db_redis_01::member::0", target: "db::n_db_redis_01::volume::0", kind: "volume", config: { mountPath: "/data" } })
  })

  it("membre : image redis + volume honore storage + auth par wrapper runtime", () => {
    const exp = expandRedis(cfg({ mode: "single", topology: { replicas: 1 } }), ctx)
    const [member] = byRole(exp, "member")
    expect(member!.config.image).toBe("redis")
    expect(member!.config.tag).toBe("7.2-alpine")
    const cmd = member!.config.cmd!.join(" ")
    expect(cmd).toContain('--requirepass "$(cat /run/secrets/db_redis)"')
    expect(cmd).toContain("--appendonly yes")
    // La valeur du mot de passe n'est JAMAIS dans la cmd (seulement le chemin).
    expect(cmd).not.toMatch(/--requirepass [A-Za-z0-9]{6,}/)
    expect(member!.config.env).toBeUndefined()
  })

  it("healthcheck data : redis-cli + REDISCLI_AUTH (jamais -a / mot de passe en argv)", () => {
    const exp = expandRedis(cfg({ mode: "single", topology: { replicas: 1 } }), ctx)
    const [member] = byRole(exp, "member")
    const test = member!.config.healthcheck!.test as string[]
    expect(test[0]).toBe("CMD")
    const s = test.join(" ")
    expect(s).toContain("redis-cli -p 6379 ping")
    expect(s).toContain('REDISCLI_AUTH="$(cat /run/secrets/db_redis)"')
    expect(s).not.toContain("-a ")
    expect(s).not.toContain("/dev/tcp")
    expect(s).not.toMatch(/--requirepass\s+\S+/)
  })

  it("connection single : writer boz_<slug>_<cache> + env DATABASE_SCHEME redis", () => {
    const exp = expandRedis(cfg({ mode: "single", topology: { replicas: 1 } }), ctx)
    expect(exp.connections).toHaveLength(1)
    const [c] = exp.connections
    expect(c!.role).toBe("writer")
    expect(c!.host).toBe("boz_proj-a_cache")
    expect(c!.port).toBe(6379)
    expect(c!.passwordSecretRef).toBe("db_redis")
    expect(c!.env).toEqual({
      DATABASE_HOST: "boz_proj-a_cache",
      DATABASE_PORT: "6379",
      DATABASE_USER: "app",
      DATABASE_NAME: "app",
      DATABASE_CREDENTIALS_FILE: "/run/secrets/db_redis",
      DATABASE_SCHEME: "redis",
    })
  })
})

describe("expandRedis HA master/réplicas + Sentinel (S8-02)", () => {
  it("inventaire : 2 data (master+replica) + 3 sentinels + réseau + 2 volumes data, 0 volume sentinel", () => {
    const exp = expandRedis(cfg({}), ctx)
    const members = byRole(exp, "member")
    expect(members).toHaveLength(2)
    expect(members.map((m) => m.name)).toEqual(["cache-1", "cache-2"])
    expect(byRole(exp, "consensus")).toHaveLength(3)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
    const vols = exp.resources.filter((r) => r.kind === "volume")
    expect(vols).toHaveLength(2)
    expect(vols.every((v) => v.data)).toBe(true)
    expect(exp.edges.length).toBe(2 * 2 + 3) // members×2 + sentinels×1
  })

  it("membre 0 = master (pas de replicaof), membres 1+ = replicaof master", () => {
    const exp = expandRedis(cfg({}), ctx)
    const members = byRole(exp, "member")
    const m0 = members[0]!.config.cmd!.join(" ")
    const m1 = members[1]!.config.cmd!.join(" ")
    expect(m0).not.toContain("--replicaof")
    expect(m1).toContain("--replicaof boz_proj-a_cache-1 6379")
    expect(m0).toContain('--masterauth "$(cat /run/secrets/db_redis)"')
    expect(m1).toContain('--requirepass "$(cat /run/secrets/db_redis)"')
    // aucune valeur en clair
    expect(m0).not.toMatch(/--requirepass [A-Za-z0-9]{6,}/)
  })

  it("Sentinel : heredoc runtime avec auth-pass + requirepass $PW, quorum majoritaire", () => {
    const exp = expandRedis(cfg({}), ctx)
    const [sentinel] = byRole(exp, "consensus")
    const cmd = sentinel!.config.cmd!.join(" ")
    expect(cmd).toContain("cat > /tmp/sentinel.conf <<CONF")
    expect(cmd).toContain("sentinel monitor mymaster boz_proj-a_cache-1 6379 2")
    expect(cmd).toContain("sentinel auth-pass mymaster $PW")
    expect(cmd).toContain("requirepass $PW")
    expect(cmd).toContain("PW=\"$(cat /run/secrets/db_redis)\"")
    expect(cmd).not.toContain("db_redis:<VALUE>")
    expect(sentinel!.config.secrets).toEqual([{ secretName: "db_redis" }])
    expect(sentinel!.config.env).toBeUndefined()
  })

  it("healthcheck Sentinel : get-master-addr-by-name + REDISCLI_AUTH, pas de -a", () => {
    const exp = expandRedis(cfg({}), ctx)
    const [sentinel] = byRole(exp, "consensus")
    const test = sentinel!.config.healthcheck!.test as string[]
    expect(test.join(" ")).toContain("sentinel get-master-addr-by-name mymaster")
    expect(test.join(" ")).toContain('REDISCLI_AUTH="$(cat /run/secrets/db_redis)"')
    expect(test.join(" ")).not.toContain("-a ")
  })

  it("consensus découplé : consensusReplicas=5 → 5 sentinels, data inchangés, quorum majoritaire 3", () => {
    const exp = expandRedis(cfg({ topology: { replicas: 2, consensusReplicas: 5 } }), ctx)
    expect(byRole(exp, "consensus")).toHaveLength(5)
    expect(byRole(exp, "member")).toHaveLength(2)
    const [sentinel] = byRole(exp, "consensus")
    expect(sentinel!.config.cmd!.join(" ")).toContain("sentinel monitor mymaster boz_proj-a_cache-1 6379 3")
  })

  it("connection HA : discovery Sentinel (host=sentinel-1, DATABASE_SENTINELS + PRIMARY_NAME)", () => {
    const exp = expandRedis(cfg({}), ctx)
    expect(exp.connections).toHaveLength(1)
    const [c] = exp.connections
    expect(c!.role).toBe("writer")
    expect(c!.host).toBe("boz_proj-a_cache-sentinel-1")
    expect(c!.port).toBe(26379)
    expect(c!.env.DATABASE_SENTINELS).toBe(
      "boz_proj-a_cache-sentinel-1:26379,boz_proj-a_cache-sentinel-2:26379,boz_proj-a_cache-sentinel-3:26379"
    )
    expect(c!.env.DATABASE_PRIMARY_NAME).toBe("mymaster")
  })

  it("round-trip ContainerConfigSchema sur chaque conteneur (HA)", () => {
    const exp = expandRedis(cfg({}), ctx)
    for (const c of containers(exp)) {
      expect(() => ContainerConfigSchema.parse(c.config)).not.toThrow()
    }
  })

  it("S8 : déterminisme + pureté (expansions identiques, zéro mutation)", () => {
    const a = JSON.stringify(expandRedis(cfg({}), ctx))
    for (let i = 0; i < 3; i++) expect(JSON.stringify(expandRedis(cfg({}), ctx))).toBe(a)
    const b = expandRedis(cfg({}), ctx)
    const snap = JSON.stringify(b)
    expandRedis(cfg({}), ctx)
    expect(JSON.stringify(b)).toBe(snap)
    expect(expandRedis(cfg({}), ctx).generatedSecrets).toEqual([])
  })
})

describe("redisProvider", () => {
  it("enregistré dans le registry", () => {
    expect(getDatabaseProvider("redis")).toBe(redisProvider)
  })

  it("validate : HA valide (replicas pairs autorisés), external+HA rejeté, single external OK", () => {
    expect(() => redisProvider.validate(cfg({}))).not.toThrow()
    const bad = cfg({
      storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext-data" },
    })
    expect(() => redisProvider.validate(bad)).toThrow(/volume externe non supporté en HA/)
    expect(() =>
      redisProvider.validate({
        ...cfg({}),
        mode: "single",
        topology: { replicas: 1 },
        storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext-data" },
      })
    ).not.toThrow()
  })

  it("refuse un moteur inattendu", () => {
    expect(() => redisProvider.validate({ ...cfg({}), engine: "postgres" } as DatabaseConfig))
      .toThrow(/provider redis : moteur postgres inattendu/)
  })
})