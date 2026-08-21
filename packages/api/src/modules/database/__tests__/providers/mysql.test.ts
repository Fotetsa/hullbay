import { describe, it, expect } from "vitest"
import { ContainerConfigSchema } from "@hullbay/shared"
import type { DatabaseConfig } from "@hullbay/shared"
import { expandMySql, mysqlProvider, mysqlConnections } from "../../providers/mysql.js"
import {
  DATABASE_PROVIDERS,
  getDatabaseProvider,
} from "../../providers/index.js"
import type { ExpansionContext, GeneratedResource } from "../../types.js"

const ctx: ExpansionContext = {
  parentNodeId: "n_db_mysql_01",
  projectSlug: "proj-a",
  parentNode: {
    id: "n_db_mysql_01",
    name: "catalog",
    type: "database",
    config: {
      engine: "mysql",
      version: "8.4",
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

const HA_REPLICAS = 3

function cfg(overrides: Partial<DatabaseConfig>): DatabaseConfig {
  return {
    ...ctx.parentNode.config,
    mode: "ha",
    topology: { replicas: HA_REPLICAS },
    ...overrides,
  }
}

function containers(exp: ReturnType<typeof expandMySql>) {
  return exp.resources.filter((r): r is GeneratedResource & { kind: "container" } => r.kind === "container")
}
function byRole(exp: ReturnType<typeof expandMySql>, role: string) {
  return containers(exp).filter((r) => r.role === role)
}
function volumes(exp: ReturnType<typeof expandMySql>) {
  return exp.resources.filter((r) => r.kind === "volume")
}

describe("mysqlProvider - registry (S6)", () => {
  it("mysql enregistré dans DATABASE_PROVIDERS / getDatabaseProvider", () => {
    expect(getDatabaseProvider("mysql")).toBe(mysqlProvider)
    expect(DATABASE_PROVIDERS.mysql?.engine).toBe("mysql")
  })
})

describe("mysqlProvider.validate (S6)", () => {
  it("single valide", () => {
    expect(() => mysqlProvider.validate(ctx.parentNode.config)).not.toThrow()
  })

  it("refuse un moteur inattendu", () => {
    expect(() => mysqlProvider.validate(cfg({ engine: "postgres" }))).toThrow(/moteur/)
  })

  it("S6-09 : external + HA rejeté (même volume partagé = corruption)", () => {
    expect(() =>
      mysqlProvider.validate(
        cfg({ storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext" } })
      )
    ).toThrow(/volume externe non supporté en HA/)
  })

  it("S6-09 : volume externe accepté en single", () => {
    expect(() =>
      mysqlProvider.validate({
        ...cfg({}),
        mode: "single",
        topology: { replicas: 1 },
        storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext" },
      })
    ).not.toThrow()
  })

  it("S6-09 : username contraint (interpolé ProxySQL → pas d'injection)", () => {
    expect(() => mysqlProvider.validate(cfg({ credentials: { ...ctx.parentNode.config.credentials!, username: `web; rm -rf /` } }))).toThrow(/username/)
    expect(() => mysqlProvider.validate(cfg({ credentials: { ...ctx.parentNode.config.credentials!, username: "web-2_b" } }))).not.toThrow()
  })
})

describe("expandMySql single (S6)", () => {
  it("inventaire : membre + réseau + volume data", () => {
    const exp = expandMySql(ctx.parentNode.config, ctx)
    expect(byRole(exp, "member")).toHaveLength(1)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
    const vols = volumes(exp)
    expect(vols).toHaveLength(1)
    expect(vols[0]!.data).toBe(true)
    expect(exp.connections).toEqual(mysqlConnections(ctx.parentNode.config, ctx))
  })

  it("membre : env sans mot de passe, secret root interne + app référencé montés", () => {
    const exp = expandMySql(ctx.parentNode.config, ctx)
    const member = byRole(exp, "member")[0]!
    const env = member.config.env as Record<string, string>
    expect(env.MYSQL_USER).toBe("catalog")
    expect(env.MYSQL_DATABASE).toBe("catalog_db")
    expect(env.MYSQL_PASSWORD_FILE).toBe("/run/secrets/db_catalog_secret")
    expect(env.MYSQL_ROOT_PASSWORD_FILE).toMatch(/^\/run\/secrets\/catalog-mysql-root-[\da-f]{8}$/)
    const secretNames = member.config.secrets!.map((s) => s.secretName)
    expect(secretNames).toContain("db_catalog_secret")
    expect(secretNames.some((s) => s.startsWith("catalog-mysql-root-"))).toBe(true)
    // Aucun mot de passe en env ni cmd.
    expect(Object.values(env).join(" ")).not.toMatch(/[0-9a-f]{24}/)
  })

  it("version du contrat appliquée au tag image", () => {
    const exp = expandMySql({ ...ctx.parentNode.config, version: "8.4" }, ctx)
    const member = byRole(exp, "member")[0]!
    expect(member.config.image).toBe("mysql")
    expect(member.config.tag).toBe("8.4")
  })

  it("healthcheck membre : CMD-SHELL mysqladmin + secret lu au runtime sans -p argv", () => {
    const exp = expandMySql(ctx.parentNode.config, ctx)
    const member = byRole(exp, "member")[0]!
    expect(member.config.healthcheck).toBeDefined()
    const test = member.config.healthcheck!.test.join(" ")
    expect(test).toContain("mysqladmin ping")
    expect(test).toContain("$(cat /run/secrets/db_catalog_secret)")
    // Le mot de passe ne transite PAS en argument process (visible via ps).
    expect(test).not.toMatch(/-p"/)
  })

  it("roundtrip parseNodeConfig sur chaque ressource générée", () => {
    const exp = expandMySql(ctx.parentNode.config, ctx)
    for (const c of containers(exp)) {
      expect(() => ContainerConfigSchema.parse(c.config)).not.toThrow()
    }
  })
})

describe("expandMySql HA Group Replication + ProxySQL (S6 §14)", () => {
  it("inventaire : 3 membres + writer/reader + réseau + 3 volumes data + 2 proxy", () => {
    const exp = expandMySql(cfg({}), ctx)
    expect(byRole(exp, "member")).toHaveLength(HA_REPLICAS)
    expect(byRole(exp, "writer")).toHaveLength(1)
    expect(byRole(exp, "reader")).toHaveLength(1)
    const vols = volumes(exp)
    expect(vols.filter((v) => v.data)).toHaveLength(HA_REPLICAS)
    expect(vols.filter((v) => !v.data)).toHaveLength(2)
    expect(containers(exp)).toHaveLength(HA_REPLICAS + 2)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
  })

  it("un service par membre : DNS boz_<slug>_<db>-<i>, replicas=1", () => {
    const exp = expandMySql(cfg({}), ctx)
    const members = byRole(exp, "member")
    expect(members.map((m) => m.name)).toEqual(["catalog-1", "catalog-2", "catalog-3"])
    expect(members.every((m) => m.config.replicas === 1)).toBe(true)
  })

  it("cmd wrapper : copie SQL init vers initdb.d, args GR GTID/binlog + local-address + seeds ; bootstrap seed conditionné datadir", () => {
    const exp = expandMySql(cfg({}), ctx)
    const members = byRole(exp, "member")
    const cmd = (m: GeneratedResource & { kind: "container" }) => m.config.cmd!.join("\n")
    const seed = cmd(members[0]!)
    const nonSeed = cmd(members[1]!)
    // 🔴#1 : l'init SQL (usagers GR) est copié vers initdb.d AVANT l'entrypoint.
    expect(seed).toContain("cp /run/secrets/catalog-gr-init-")
    expect(seed).toContain("/docker-entrypoint-initdb.d/00-gr-init.sql")
    // Bootstrap n'arrive QUE si le datadir est vierge (pas de split-brain au restart).
    expect(seed).toMatch(/if \[ -d \/var\/lib\/mysql\/mysql \]/)
    expect(seed).toContain("--group-replication-bootstrap-group=ON")
    expect(seed).not.toContain("MONGOD_PID")
    expect(nonSeed).not.toContain("--group-replication-bootstrap-group=ON")
    for (const m of members) {
      const a = cmd(m)
      expect(a).toContain("--gtid-mode=ON")
      expect(a).toContain("--binlog-format=ROW")
      expect(a).toContain("--group-replication-start-on-boot=ON")
      expect(a).toContain("--group-replication-group-seeds=")
    }
    // 🔴#2 : GCS joignable — local-address ≠ 127.0.0.1:33061.
    expect(cmd(members[0]!)).toContain("--group-replication-local-address=boz_proj-a_catalog-1:33061")
    expect(cmd(members[1]!)).toContain("--group-replication-local-address=boz_proj-a_catalog-2:33061")
    expect(cmd(members[0]!)).not.toContain("--group-replication-local-address=127.0.0.1")
    expect(cmd(members[1]!)).not.toContain("--group-replication-local-address=127.0.0.1")
    // server-id unique : 1, 2, 3.
    expect([cmd(members[0]!), cmd(members[1]!), cmd(members[2]!)].map((c) => c.match(/--server-id=(\d)/)![1]))
      .toEqual(["1", "2", "3"])
  })

  it("config-secrets : init SQL GR par membre (versionné) + recovery persistée", () => {
    const exp = expandMySql(cfg({}), ctx)
    const initSecrets = exp.generatedSecrets.filter((s) => s.name.includes("gr-init-"))
    expect(initSecrets).toHaveLength(HA_REPLICAS)
    // Chaque membre monte SON init SQL.
    const members = byRole(exp, "member")
    for (let i = 0; i < HA_REPLICAS; i++) {
      const sql = initSecrets.find((s) => s.name.includes(`gr-init-${i + 1}-`))!
      expect(sql).toBeDefined()
      expect(sql.data).toContain("CREATE USER IF NOT EXISTS 'mysql_repl'@'%'")
      expect(sql.data).toContain("mysql_monitor")
      expect(sql.data).toContain("SET PERSIST group_replication_recovery_user")
      // ≠ hash de nom si l'init secret n'est pas identique au membre monté.
      expect(members[i]!.config.secrets!.some((s) => s.secretName === sql.name)).toBe(true)
    }
  })

  it("ProxySQL : cnf template sans valeur applicative, placeholders remplis au runtime", () => {
    const exp = expandMySql(cfg({}), ctx)
    const templates = exp.generatedSecrets.filter((s) => s.name.includes("proxysql-"))
    for (const t of templates) {
      if (t.name.includes("admin")) continue
      // Le template ne contient JAMAIS le mot de passe applicatif ni le secret ref.
      expect(t.data).not.toContain("db_catalog_secret")
      expect(t.data).toContain("__APP_PW__")
      expect(t.data).toContain("__APP_USER__")
      expect(t.data).toContain("mysql_group_replication_hostgroups")
      expect(t.data).toContain("monitor_password=")
    }
    // L'endpoint writer par défaut → hostgroup 10, reader → 20.
    const writerTpl = exp.generatedSecrets.find((s) => s.name.includes("proxysql-writer-"))!.data
    const readerTpl = exp.generatedSecrets.find((s) => s.name.includes("proxysql-reader-"))!.data
    expect(writerTpl).toContain("default_hostgroup = 10")
    expect(readerTpl).toContain("default_hostgroup = 20")
  })

  it("proxy : wrapper cmd lit le secret app au runtime, secrets montés, volume data:false", () => {
    const exp = expandMySql(cfg({}), ctx)
    const writer = byRole(exp, "writer")[0]!
    const cmd = writer.config.cmd!.join("\n")
    expect(cmd).toContain("cat /run/secrets/db_catalog_secret")
    expect(cmd).toContain("exec proxysql --initial -f /tmp/proxysql.cnf")
    const secretNames = writer.config.secrets!.map((s) => s.secretName)
    expect(secretNames).toContain("db_catalog_secret")
    expect(secretNames.some((s) => s.includes("proxysql-writer-admin-"))).toBe(true)
    expect(secretNames.length).toBe(3)
    // Pas de mot de passe en clair dans cmd/env proxy.
    const proxyEnv = writer.config.env as Record<string, string>
    expect(proxyEnv.MYSQL_APP_USER).toBe("catalog")
    expect(proxyEnv.MYSQL_APP_USER).not.toContain("secret")
    const proxyVols = (exp.resources.filter((r): r is GeneratedResource & { kind: "volume" } => r.kind === "volume" && r.name.includes("proxysql")))
    expect(proxyVols.every((v) => v.data === false)).toBe(true)
  })

  it("connections : writer/reader via ProxySQL, env DATABASE_* + SCHEME", () => {
    const exp = expandMySql(cfg({}), ctx)
    const writer = exp.connections.find((c) => c.role === "writer")!
    const reader = exp.connections.find((c) => c.role === "reader")!
    expect(writer.host).toBe("boz_proj-a_catalog-writer")
    expect(writer.port).toBe(6033)
    expect(reader.host).toBe("boz_proj-a_catalog-reader")
    expect(reader.port).toBe(6034)
    expect(writer.passwordSecretRef).toBe("db_catalog_secret")
    expect(writer.env).toMatchObject({
      DATABASE_HOST: "boz_proj-a_catalog-writer",
      DATABASE_PORT: "6033",
      DATABASE_USER: "catalog",
      DATABASE_NAME: "catalog_db",
      DATABASE_CREDENTIALS_FILE: "/run/secrets/db_catalog_secret",
      DATABASE_SCHEME: "mysql",
    })
    expect(reader.env).toMatchObject({
      DATABASE_READ_HOST: "boz_proj-a_catalog-reader",
      DATABASE_READ_PORT: "6034",
      DATABASE_READ_CREDENTIALS_FILE: "/run/secrets/db_catalog_secret",
      DATABASE_READ_SCHEME: "mysql",
    })
  })

  it("placement membres : spread node.id, sans contrainte worker (mono-nœud)", () => {
    const exp = expandMySql(cfg({}), ctx)
    for (const m of byRole(exp, "member")) {
      const placement = m.config.placement as { constraints?: string[] } | undefined
      expect(placement?.constraints ?? []).not.toContain("node.role==worker")
    }
  })

  it("S6-13 : déterminisme — 10 expansions identiques", () => {
    const first = JSON.stringify(expandMySql(cfg({}), ctx))
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(expandMySql(cfg({}), ctx))).toBe(first)
    }
  })

  it("expansion pure : rien n'est muté entre deux appels", () => {
    const a = expandMySql(cfg({}), ctx)
    const snapshot = JSON.stringify(a)
    expandMySql(cfg({}), ctx)
    expect(JSON.stringify(a)).toBe(snapshot)
  })

  it("roundtrip ContainerConfigSchema sur chaque conteneur généré (HA)", () => {
    const exp = expandMySql(cfg({}), ctx)
    for (const c of containers(exp)) {
      expect(() => ContainerConfigSchema.parse(c.config)).not.toThrow()
    }
  })
})