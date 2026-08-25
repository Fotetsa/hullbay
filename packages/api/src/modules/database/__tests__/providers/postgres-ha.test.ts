import { describe, it, expect } from "vitest"
import { ContainerConfigSchema } from "@hullbay/shared"
import type { DatabaseConfig } from "@hullbay/shared"
import { expandPostgres, postgresProvider, postgresConnections } from "../../providers/postgres.js"
import type { ExpansionContext, GeneratedResource } from "../../types.js"

const ctx: ExpansionContext = {
  parentNodeId: "n_db_ha_01",
  projectSlug: "proj-a",
  parentNode: {
    id: "n_db_ha_01",
    name: "catalog",
    type: "database",
    config: {
      engine: "postgres",
      version: "16.3",
      mode: "single", // mode réel : config.topology driven ; on passe "ha" via overrides.
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
const HA_CONSENSUS = 3

function cfg(overrides: Partial<DatabaseConfig>): DatabaseConfig {
  return {
    ...ctx.parentNode.config,
    mode: "ha",
    topology: { replicas: HA_REPLICAS, consensusReplicas: undefined },
    ...overrides,
  }
}

function containers(exp: ReturnType<typeof expandPostgres>) {
  return exp.resources.filter((r): r is GeneratedResource & { kind: "container" } => r.kind === "container")
}
function byRole(exp: ReturnType<typeof expandPostgres>, role: string) {
  return containers(exp).filter((r) => r.role === role)
}
function volumes(exp: ReturnType<typeof expandPostgres>) {
  return exp.resources.filter((r) => r.kind === "volume")
}

describe("expandPostgres HA (S4 §12-13)", () => {
  it("inventaire : 3 membres Patroni + 3 etcd + writer + reader + réseau + 6 volumes", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(byRole(exp, "member")).toHaveLength(HA_REPLICAS)
    expect(byRole(exp, "consensus")).toHaveLength(HA_CONSENSUS)
    expect(byRole(exp, "writer")).toHaveLength(1)
    expect(byRole(exp, "reader")).toHaveLength(1)
    const vols = volumes(exp)
    expect(vols.filter((v) => v.data)).toHaveLength(HA_REPLICAS)
    expect(vols.filter((v) => !v.data)).toHaveLength(HA_CONSENSUS)
    expect(exp.resources.filter((r) => r.kind === "network")).toHaveLength(1)
    expect(containers(exp)).toHaveLength(HA_REPLICAS + HA_CONSENSUS + 2)
  })

  it("un service par membre : DNS individuels boz_<slug>_<db>-<i>, replicas=1", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const members = byRole(exp, "member")
    const names = members.map((m) => m.name)
    expect(names).toEqual(["catalog-1", "catalog-2", "catalog-3"])
    expect(members.map((m) => m.config.replicas)).toEqual([1, 1, 1])
    expect(members.map((m) => m.config.env!.PATRONI_POSTGRESQL_CONNECT_ADDRESS)).toEqual([
      "boz_proj-a_catalog-1:5432",
      "boz_proj-a_catalog-2:5432",
      "boz_proj-a_catalog-3:5432",
    ])
  })

  it("nodeIds synthétiques HA (member, consensus, writer, reader, volumes répartis)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const ids = exp.resources.map((r) => r.nodeId)
    for (let i = 0; i < HA_REPLICAS; i++) {
      expect(ids).toContain(`db::n_db_ha_01::member::${i}`)
      expect(ids).toContain(`db::n_db_ha_01::volume::${i}`)
      expect(ids).toContain(`db::n_db_ha_01::consensus::${i}`)
      expect(ids).toContain(`db::n_db_ha_01::consensus-volume::${i}`)
    }
    expect(ids).toContain("db::n_db_ha_01::writer::0")
    expect(ids).toContain("db::n_db_ha_01::reader::0")
    expect(ids).toContain("db::n_db_ha_01::network::0")
  })

  it("edges : 3×(membre→net+vol data) + 3×(etcd→net+vol coordination) + writer/reader→net", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(exp.edges).toHaveLength(HA_REPLICAS * 2 + HA_CONSENSUS * 2 + 2)
    for (let i = 0; i < HA_REPLICAS; i++) {
      const member = `db::n_db_ha_01::member::${i}`
      const vol = `db::n_db_ha_01::volume::${i}`
      expect(exp.edges).toContainEqual({ source: member, target: "db::n_db_ha_01::network::0", kind: "network" })
      expect(exp.edges).toContainEqual({
        source: member,
        target: vol,
        kind: "volume",
        config: { mountPath: "/var/lib/postgresql/data" },
      })
    }
    for (let i = 0; i < HA_CONSENSUS; i++) {
      const etcd = `db::n_db_ha_01::consensus::${i}`
      const vol = `db::n_db_ha_01::consensus-volume::${i}`
      expect(exp.edges).toContainEqual({ source: etcd, target: "db::n_db_ha_01::network::0", kind: "network" })
      expect(exp.edges).toContainEqual({
        source: etcd,
        target: vol,
        kind: "volume",
        config: { mountPath: "/etcd-data" },
      })
    }
    expect(exp.edges).toContainEqual({ source: "db::n_db_ha_01::writer::0", target: "db::n_db_ha_01::network::0", kind: "network" })
    expect(exp.edges).toContainEqual({ source: "db::n_db_ha_01::reader::0", target: "db::n_db_ha_01::network::0", kind: "network" })
  })

  it("S2-06/S4 : healthchecks exec distincts (patroni /health, etcd health, haproxy nc)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const [member] = byRole(exp, "member")
    const [etcd] = byRole(exp, "consensus")
    const [writer] = byRole(exp, "writer")
    expect(member!.config.healthcheck!.test).toEqual(["CMD", "curl", "-fsS", "http://127.0.0.1:8008/health"])
    expect(etcd!.config.healthcheck!.test).toEqual(["CMD", "etcdctl", "endpoint", "health"])
    expect(writer!.config.healthcheck!.test).toEqual(["CMD", "sh", "-c", "nc -z 127.0.0.1 5432"])
  })

  it("placement : spread sur node.id, SANS contrainte node.role==worker (member/etcd)", () => {
    // Contrainte worker rendrait le HA inschedulable sur un cluster mono-nœud
    // (manager+worker par défaut). Les managers dédiés se drainent via availability.
    const exp = expandPostgres(cfg({}), ctx)
    const [member] = byRole(exp, "member")
    const [etcd] = byRole(exp, "consensus")
    expect(member!.config.placement).toEqual({ constraints: [], spreadOver: ["node.id"] })
    expect(etcd!.config.placement).toEqual({ constraints: [], spreadOver: ["node.id"] })
  })

  it("aucun secret en env ni cmd : mots de passe montés en fichiers, URLs seulement", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const [member] = byRole(exp, "member")
    const env = member!.config.env!
    // Le mot de passe utilisateur et la replication value ne sont JAMAIS en clair.
    expect(env.PATRONI_SUPERUSER_PASSWORD_FILE).toBe("/run/secrets/db_catalog_secret")
    expect(env.PATRONI_REPLICATION_PASSWORD_FILE).toMatch(/^\/run\/secrets\/catalog-replication-/)
    // REST API : basic-auth internes (dérivées, jamais utilisateur) — n'exposent
    // que les endpoints "unsafe" (POST /failover) ; GET /health restent libres.
    expect(env.PATRONI_RESTAPI_USERNAME).toBe("patroni")
    // La VALEUR restapi n'est plus dans l'env du service : jamais en clair.
    expect(env.PATRONI_RESTAPI_PASSWORD).toBeUndefined()
    // … mais montée en config-secret généré et injectée par le cmd-wrapper.
    const restapiSecret = exp.generatedSecrets.find((s) => s.name.startsWith("catalog-patroni-restapi-"))!
    expect(restapiSecret.data).toMatch(/^[0-9a-f]{24}$/)
    expect(member!.config.secrets!.map((s) => s.secretName)).toContain(restapiSecret.name)
    // Le secret réplication (sa VALEUR) ne peut apparaître que via _FILE : jamais
    // d'URL, de mot de passe ou de valeur dérivée en clair dans l'env.
    expect(env.PATRONI_ETCD_HOSTS).toMatch(/^boz_proj-a_catalog-etcd-1:2379,boz_proj-a_catalog-etcd-2:2379,boz_proj-a_catalog-etcd-3:2379$/)
    // cmd wrapper membre : gate recovery + kill -0 + logs d'échec, sans la valeur
    // des secrets réplication/restapi (uniquement le cat du fichier monté).
    const mc = member!.config.cmd!.join(" ")
    expect(mc).toMatch(/^sh -c set -eu/)
    expect(mc).toContain("/opt/bitnami/scripts/patroni/entrypoint.sh")
    expect(mc).toContain(`CREATE DATABASE "catalog_db" OWNER "catalog"`)
    expect(mc).toContain("pg_is_in_recovery")
    expect(mc).toContain('kill -0 "$PATRONI_PID"')
    expect(mc).toContain("ÉCHEC création base 'catalog_db'")
    expect(mc).toContain("/run/secrets/db_catalog_secret")
    expect(mc).toContain(`export PATRONI_RESTAPI_PASSWORD="$(cat '/run/secrets/${restapiSecret.name}')"`)
    const rep = exp.generatedSecrets.find((s) => s.name.startsWith("catalog-replication-"))!
    expect(mc).not.toContain(rep.data)
    expect(mc).not.toContain(restapiSecret.data)
    // etcd : wrapper (existing si datadir OU cluster vivant, new sinon), pas de
    // `new`/`existing` en dur et pas de méta-token.
    const [etcd] = byRole(exp, "consensus")
    const ecmd = etcd!.config.cmd!.join(" ")
    expect(ecmd).toMatch(/^sh -c/)
    expect(ecmd).toContain('if [ -d "${DATA_DIR}/member" ]')
    expect(ecmd).toContain('etcdctl --endpoints="$CLIENTS" member list')
    expect(ecmd).toContain("STATE=existing")
    expect(ecmd).toContain("STATE=new")
    expect(ecmd).toContain("--initial-cluster=etcd-1=http://boz_proj-a_catalog-etcd-1:2380,etcd-2=http://boz_proj-a_catalog-etcd-2:2380,etcd-3=http://boz_proj-a_catalog-etcd-3:2380")
    expect(ecmd).not.toContain("--initial-cluster-state=new")
    expect(ecmd).not.toContain("--initial-cluster-state=existing")
    expect(ecmd).toContain('--initial-cluster-state="${STATE}"')
  })

  it("secret réplication : monté sur chaque membre via secrets[], déterminisme absolu", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const [member] = byRole(exp, "member")
    const replicationSecret = member!.config.secrets!.find((s) => s.secretName.startsWith("catalog-replication-"))!.secretName
    const restapiSecret = member!.config.secrets!.find((s) => s.secretName.startsWith("catalog-patroni-restapi-"))!.secretName
    expect(member!.config.secrets).toEqual([
      { secretName: "db_catalog_secret" },
      { secretName: replicationSecret },
      { secretName: restapiSecret },
    ])
    const gen = exp.generatedSecrets.find((s) => s.name === replicationSecret)!
    expect(gen.data).toMatch(/^[0-9a-f]{24}$/)
    // Même nœud → même valeur ; déterministe entre deux expansions.
    const again = expandPostgres(cfg({}), ctx)
    const gen2 = again.generatedSecrets.find((s) => s.name === replicationSecret)!
    expect(gen2.data).toBe(gen.data)
    // Les secrets générés (replication + restapi) sont référencés par les trois
    // membres — UNE seule entrée chacun dans generatedSecrets.
    const refs = byRole(exp, "member").map((m) => m.config.secrets!.filter((s) => s.secretName !== "db_catalog_secret"))
    const shared = refs.flat().map((s) => s.secretName)
    expect(new Set(shared).size).toBe(2)
  })

  it("S5-13: audit — aucune valeur de secret généré en env, cmd, nom ni ownership", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const secretValues = exp.generatedSecrets.map((s) => s.data)
    expect(secretValues.length).toBeGreaterThan(0)
    for (const r of containers(exp)) {
      const envBlob = JSON.stringify(r.config.env ?? {})
      const cmdBlob = (r.config.cmd ?? []).join(" ")
      const nameBlob = `${r.name} ${r.role} ${r.nodeId}`
      for (const v of secretValues) {
        expect(envBlob, `env du ${r.name} contient une valeur secrète`).not.toContain(v)
        expect(cmdBlob, `cmd du ${r.name} contient une valeur secrète`).not.toContain(v)
        expect(nameBlob, `nom du ${r.name} contient une valeur secrète`).not.toContain(v)
      }
    }
  })

  it("config-secrets HAProxy : nom versionné par hash8 du contenu, contenu attendu", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const writer = exp.generatedSecrets.find((s) => s.name.includes("haproxy-writer"))!
    const reader = exp.generatedSecrets.find((s) => s.name.includes("haproxy-reader"))!
    expect(writer.name).toMatch(/^catalog-haproxy-writer-[0-9a-f]{8}$/)
    expect(reader.name).toMatch(/^catalog-haproxy-reader-[0-9a-f]{8}$/)
    expect(writer.data).toContain("option httpchk GET /primary")
    expect(reader.data).toContain("option httpchk GET /replica")
    expect(writer.data).toContain("server m1 boz_proj-a_catalog-1:5432 check port 8008")
    expect(reader.data).toContain("server m2 boz_proj-a_catalog-2:5432 check port 8008")
  })

  it("consensus découplé : consensusReplicas=5 → 5 etcd, data-replicas inchangés", () => {
    const exp = expandPostgres(cfg({ topology: { replicas: HA_REPLICAS, consensusReplicas: 5 } }), ctx)
    expect(byRole(exp, "consensus")).toHaveLength(5)
    expect(byRole(exp, "member")).toHaveLength(HA_REPLICAS)
  })

  it("volumes data=true (rétention) vs coordination data=false", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const dataVols = volumes(exp).filter((v) => v.name.startsWith("catalog-data-"))
    const etcdVols = volumes(exp).filter((v) => v.name.startsWith("catalog-etcd-data-"))
    expect(dataVols).toHaveLength(HA_REPLICAS)
    expect(etcdVols).toHaveLength(HA_CONSENSUS)
    expect(dataVols.every((v) => v.data)).toBe(true)
    expect(etcdVols.every((v) => !v.data)).toBe(true)
  })

  it("S4-11 : config membre passe le round-trip ContainerConfigSchema", () => {
    const exp = expandPostgres(cfg({}), ctx)
    const [member] = byRole(exp, "member")
    const parsed = ContainerConfigSchema.parse(member!.config)
    expect(parsed.image).toBe("bitnami/patroni")
    expect(parsed.env.PATRONI_SCOPE).toBe("catalog")
  })

  it("S4-12 : connections = writer + reader, env séparées, hosts déterministes", () => {
    const exp = expandPostgres(cfg({}), ctx)
    expect(exp.connections).toHaveLength(2)
    const [writer, reader] = exp.connections
    expect(writer!.role).toBe("writer")
    expect(reader!.role).toBe("reader")
    expect(writer!.host).toBe("boz_proj-a_catalog-writer")
    expect(reader!.host).toBe("boz_proj-a_catalog-reader")
    expect(writer!.port).toBe(5432)
    expect(reader!.port).toBe(5432)
    expect(writer!.passwordSecretRef).toBe("db_catalog_secret")
    expect(reader!.passwordSecretRef).toBe("db_catalog_secret")
    // Writer : env DATABASE_* EXACTE, sans DATABASE_READ_*.
    expect(writer!.env).toEqual({
      DATABASE_HOST: "boz_proj-a_catalog-writer",
      DATABASE_PORT: "5432",
      DATABASE_USER: "catalog",
      DATABASE_NAME: "catalog_db",
      DATABASE_CREDENTIALS_FILE: "/run/secrets/db_catalog_secret",
      DATABASE_SCHEME: "postgresql",
    })
    // Reader : env DATABASE_READ_* exacte (l'app fusionne les deux endpoints).
    expect(reader!.env).toEqual({
      DATABASE_READ_HOST: "boz_proj-a_catalog-reader",
      DATABASE_READ_PORT: "5432",
      DATABASE_READ_CREDENTIALS_FILE: "/run/secrets/db_catalog_secret",
      DATABASE_READ_SCHEME: "postgresql",
    })
    // Cohérence : la connexion est la même fonction que les endpoints de l'exp.
    expect(exp.connections).toEqual(postgresConnections(cfg({}), ctx))
  })

  it("validate accepte le mode HA (3/5/7)", () => {
    expect(() => postgresProvider.validate(cfg({}))).not.toThrow()
  })

  it("S4-13 : déterminisme — 10 expansions identiques", () => {
    const first = JSON.stringify(expandPostgres(cfg({}), ctx))
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(expandPostgres(cfg({}), ctx))).toBe(first)
    }
  })

  it("expansion pure : rien de généré n'est muté entre deux appels", () => {
    const a = expandPostgres(cfg({}), ctx)
    const snapshot = JSON.stringify(a)
    expandPostgres(cfg({}), ctx)
    expect(JSON.stringify(a)).toBe(snapshot)
  })

  it("version du contrat honorée en HA : POSTGRESQL_VERSION = config.version", () => {
    const exp = expandPostgres(cfg({ version: "16.3" }), ctx)
    const member = byRole(exp, "member")[0]!
    const env = member.config.env as Record<string, string>
    expect(env.POSTGRESQL_VERSION).toBe("16.3")
  })

  it("placement HA sans contrainte node.role==worker (déployable sur mono-nœud)", () => {
    const exp = expandPostgres(cfg({}), ctx)
    for (const m of containers(exp)) {
      const placement = m.config.placement as { constraints?: string[] } | undefined
      expect(placement?.constraints ?? []).not.toContain("node.role==worker")
    }
  })

  it("S5-09 : external + HA rejeté (même volume partagé = corruption PGDATA)", () => {
    const bad = cfg({
      storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext-data" },
    })
    expect(() => postgresProvider.validate(bad)).toThrow(/volume externe non supporté en HA/)
    // Mode single : le volume externe reste autorisé (étroitesse assumée).
    expect(() =>
      postgresProvider.validate({
        ...cfg({}),
        mode: "single",
        topology: { replicas: 1 },
        storage: { driver: "local", driverOpts: {}, external: true, externalName: "ext-data" },
      })
    ).not.toThrow()
  })
})