import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { BACKUP_STRATEGY_BY_KIND, type BackupTargetKind } from "@hullbay/shared"
import { getStrategy, defaultStrategyFor, strategiesFor } from "../strategies/registry"
import { postgresStrategy } from "../strategies/postgres"
import { mysqlStrategy } from "../strategies/mysql"
import { mongodbStrategy } from "../strategies/mongodb"
import { redisStrategy } from "../strategies/redis"
import { volumeStrategy } from "../strategies/volume"
import { NotImplementedError } from "../strategies/types"

const ROOT = path.resolve(__dirname, "..")

const target = {
  nodeId: "n1",
  name: "orders-db",
  kind: "postgres" as const,
  engine: "postgres",
  engineVersion: "16.4",
  host: "boz_shop_db",
  port: 5432,
  database: "orders",
  username: "app",
  passwordSecretRef: "orders_db_password",
}

describe("PostgresStrategy", () => {
  it("produit un payload sql.gz restaurable avec psql", () => {
    const plan = postgresStrategy.backup(target)
    expect(plan.payloadFormat).toBe("sql.gz")
    expect(plan.extractionScript).toContain("pg_dump")
    expect(plan.extractionScript).toContain("gzip")
    expect(plan.restoreCommand).toContain("gunzip -c payload.sql.gz | psql")
  })

  it("ne met jamais le mot de passe dans la commande", () => {
    const plan = postgresStrategy.backup(target)
    expect(plan.extractionScript).not.toContain("orders_db_password")
    expect(plan.extractionScript).not.toMatch(/PGPASSWORD=/)
    expect(plan.extractionScript).toContain("PGPASSFILE")
  })

  it("vérifie la version du client avant le transfert", () => {
    const plan = postgresStrategy.backup(target)
    expect(plan.prereqScript).toContain("required=16")
    expect(plan.prereqScript).toContain("exit 3")
    expect(plan.requires).toMatchObject({ engineMajor: ">=16" })
  })

  it("échappe les valeurs interpolées dans le script", () => {
    const plan = postgresStrategy.backup({ ...target, database: "o'rders" })
    expect(plan.extractionScript).toContain("--dbname='o'\\''rders'")
  })

  it("refuse une version illisible au lieu de deviner", () => {
    expect(postgresStrategy.verifyPrereqs({ ...target, engineVersion: "latest" }).ok).toBe(false)
    expect(postgresStrategy.verifyPrereqs({ ...target, engineVersion: "16.4" }).ok).toBe(true)
  })

  it("déclare restore() mais ne l'implémente pas en V1", async () => {
    await expect(postgresStrategy.restore("art", target)).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})

const mysqlTarget = {
  nodeId: "n2",
  name: "billing-db",
  kind: "mysql" as const,
  engine: "mysql",
  engineVersion: "8.0.36",
  host: "boz_shop_mysql",
  port: 3306,
  database: "billing",
  username: "app",
  passwordSecretRef: "billing_db_password",
}

describe("MysqlStrategy", () => {
  it("produit un payload sql.gz restaurable avec mysql", () => {
    const plan = mysqlStrategy.backup(mysqlTarget)
    expect(plan.payloadFormat).toBe("sql.gz")
    expect(plan.extractionScript).toContain("mysqldump")
    expect(plan.extractionScript).toContain("--single-transaction")
    expect(plan.extractionScript).toContain("gzip")
    expect(plan.restoreCommand).toContain("gunzip -c payload.sql.gz | mysql")
  })

  it("ne met jamais le mot de passe dans la commande ni dans l'environnement", () => {
    const plan = mysqlStrategy.backup(mysqlTarget)
    expect(plan.extractionScript).not.toContain("billing_db_password")
    expect(plan.extractionScript).not.toMatch(/--password=/)
    expect(plan.extractionScript).toContain("--defaults-extra-file=/tmp/.my.cnf")
    expect(Object.values(plan.env ?? {})).not.toContain("billing_db_password")
  })

  it("verrouille le fichier de credentials", () => {
    expect(mysqlStrategy.backup(mysqlTarget).extractionScript).toContain("umask 077")
  })

  it("vérifie la majeure du client avant le transfert", () => {
    const plan = mysqlStrategy.backup(mysqlTarget)
    expect(plan.prereqScript).toContain("required=8")
    expect(plan.prereqScript).toContain("exit 3")
    expect(plan.requires).toMatchObject({ engineMajor: ">=8" })
  })

  it("refuse une version illisible au lieu de deviner", () => {
    expect(mysqlStrategy.verifyPrereqs({ ...mysqlTarget, engineVersion: "latest" }).ok).toBe(false)
    expect(mysqlStrategy.verifyPrereqs(mysqlTarget).ok).toBe(true)
  })

  it("déclare restore() mais ne l'implémente pas en V1", async () => {
    await expect(mysqlStrategy.restore("art", mysqlTarget)).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})

const mongodbTarget = {
  nodeId: "n3",
  name: "events-db",
  kind: "mongodb" as const,
  engine: "mongodb",
  engineVersion: "6.0.14",
  host: "boz_shop_mongo",
  port: 27017,
  database: "events",
  username: "app",
  passwordSecretRef: "events_db_password",
}

describe("MongodbStrategy", () => {
  it("produit une archive gzip restaurable avec mongorestore", () => {
    const plan = mongodbStrategy.backup(mongodbTarget)
    expect(plan.payloadFormat).toBe("archive.gz")
    expect(plan.extractionScript).toContain("mongodump --config /tmp/mongodump.yaml")
    expect(plan.extractionScript).toContain("--archive --gzip")
    expect(plan.restoreCommand).toContain("mongorestore --archive --gzip")
  })

  it("ne met jamais l'URI ni le mot de passe dans les arguments", () => {
    const plan = mongodbStrategy.backup(mongodbTarget)
    expect(plan.extractionScript).not.toContain("events_db_password")
    expect(plan.extractionScript).not.toMatch(/--uri\s/)
    expect(plan.extractionScript).toContain('uri: "mongodb://$SRC_USER:$ESC@')
    expect(Object.values(plan.env ?? {})).not.toContain("events_db_password")
  })

  it("échappe les caractères spéciaux du mot de passe dans le YAML", () => {
    expect(mongodbStrategy.backup(mongodbTarget).extractionScript).toContain("sed")
  })

  it("vérifie la présence de l'outil sans comparer une majeure non pertinente", () => {
    const plan = mongodbStrategy.backup(mongodbTarget)
    expect(plan.prereqScript).toContain("command -v mongodump")
    expect(plan.prereqScript).toContain("exit 3")
    expect(plan.requires).toEqual({})
  })

  it("refuse une version illisible au lieu de deviner", () => {
    expect(mongodbStrategy.verifyPrereqs({ ...mongodbTarget, engineVersion: "latest" }).ok).toBe(
      false,
    )
    expect(mongodbStrategy.verifyPrereqs(mongodbTarget).ok).toBe(true)
  })

  it("déclare restore() mais ne l'implémente pas en V1", async () => {
    await expect(mongodbStrategy.restore("art", mongodbTarget)).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})

const redisTarget = {
  nodeId: "n4",
  name: "cache",
  kind: "redis" as const,
  engine: "redis",
  engineVersion: "7.2",
  host: "boz_shop_cache",
  port: 6379,
  username: "default",
  passwordSecretRef: "cache_password",
}

describe("RedisStrategy", () => {
  it("streame un snapshot RDB sans écrire sur le disque du nœud", () => {
    const plan = redisStrategy.backup(redisTarget)
    expect(plan.payloadFormat).toBe("rdb.gz")
    expect(plan.extractionScript).toContain("--rdb -")
    expect(plan.extractionScript).toContain("gzip")
    expect(plan.extractionScript).not.toContain("BGSAVE")
  })

  it("ne met jamais le mot de passe dans les arguments", () => {
    const plan = redisStrategy.backup(redisTarget)
    expect(plan.extractionScript).not.toContain("cache_password")
    expect(plan.extractionScript).not.toMatch(/\s-a\s/)
    expect(plan.extractionScript).toContain('export REDISCLI_AUTH="$(cat "$DB_PASSWORD_FILE")"')
    expect(plan.extractionScript).toContain("--no-auth-warning")
  })

  it("n'exige aucun prérequis de version", () => {
    expect(redisStrategy.verifyPrereqs(redisTarget).ok).toBe(true)
    expect(redisStrategy.backup(redisTarget).prereqScript).toBeUndefined()
  })

  it("déclare restore() mais ne l'implémente pas en V1", async () => {
    await expect(redisStrategy.restore("art", redisTarget)).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})

const volumeTarget = {
  nodeId: "n5",
  name: "uploads",
  kind: "volume" as const,
  engine: "volume",
  engineVersion: "1",
  host: "boz_shop_web",
  port: 0,
  username: "root",
  volumeName: "boz_shop_uploads",
  mountPath: "/data",
}

describe("VolumeStrategy", () => {
  it("produit une archive tar.gz du volume monté en lecture seule", () => {
    const plan = volumeStrategy.backup(volumeTarget)
    expect(plan.payloadFormat).toBe("tar.gz")
    expect(plan.extractionScript).toContain('tar -C "/data" -czf - .')
    expect(plan.restoreCommand).toContain("tar -xzf payload.tar.gz -C /data")
  })

  it("échoue avant transfert si le volume n'est pas monté", () => {
    const plan = volumeStrategy.backup(volumeTarget)
    expect(plan.prereqScript).toContain('if [ ! -d "/data" ]')
    expect(plan.prereqScript).toContain("exit 3")
  })

  it("respecte un point de montage personnalisé", () => {
    const plan = volumeStrategy.backup({ ...volumeTarget, mountPath: "/var/lib/uploads" })
    expect(plan.extractionScript).toContain('tar -C "/var/lib/uploads" -czf - .')
    expect(plan.prereqScript).toContain("/var/lib/uploads")
  })

  it("produit une archive réellement restaurable (roundtrip tar)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hullbay-vol-"))
    const source = path.join(root, "source dir")
    const restored = path.join(root, "restored")
    mkdirSync(source, { recursive: true })
    mkdirSync(restored, { recursive: true })
    writeFileSync(path.join(source, "notes.txt"), "contenu applicatif")
    writeFileSync(path.join(source, "fichier avec espaces.txt"), "ok")

    try {
      const plan = volumeStrategy.backup({ ...volumeTarget, mountPath: source })
      const archive = execFileSync("bash", ["-c", plan.extractionScript], {
        maxBuffer: 10 * 1024 * 1024,
      })
      const payload = path.join(root, "payload.tar.gz")
      writeFileSync(payload, archive)
      execFileSync("tar", ["-xzf", payload, "-C", restored])

      expect(readFileSync(path.join(restored, "notes.txt"), "utf8")).toBe("contenu applicatif")
      expect(readFileSync(path.join(restored, "fichier avec espaces.txt"), "utf8")).toBe("ok")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuse par défaut un volume de données de base", () => {
    expect(() => volumeStrategy.backup({ ...volumeTarget, isDataVolume: true })).toThrow(
      /données de base/,
    )
  })

  it("n'accepte un volume de données de base que sur override explicite", () => {
    const plan = volumeStrategy.backup({
      ...volumeTarget,
      isDataVolume: true,
      allowDataVolume: true,
    })
    expect(plan.payloadFormat).toBe("tar.gz")
  })

  it("déclare restore() mais ne l'implémente pas en V1", async () => {
    await expect(volumeStrategy.restore("art", volumeTarget)).rejects.toBeInstanceOf(
      NotImplementedError,
    )
  })
})

describe("registry de stratégies", () => {
  it("résout chaque stratégie par identifiant", () => {
    expect(getStrategy("postgres.pg_dump")).toBe(postgresStrategy)
    expect(getStrategy("mysql.mysqldump")).toBe(mysqlStrategy)
    expect(getStrategy("mongodb.mongodump")).toBe(mongodbStrategy)
    expect(getStrategy("redis.rdb")).toBe(redisStrategy)
    expect(getStrategy("volume.tar")).toBe(volumeStrategy)
  })

  it("liste les stratégies par type de cible", () => {
    expect(strategiesFor("postgres").map((s) => s.id)).toEqual(["postgres.pg_dump"])
    expect(strategiesFor("mysql").map((s) => s.id)).toEqual(["mysql.mysqldump"])
    expect(strategiesFor("mongodb").map((s) => s.id)).toEqual(["mongodb.mongodump"])
    expect(strategiesFor("redis").map((s) => s.id)).toEqual(["redis.rdb"])
    expect(strategiesFor("volume").map((s) => s.id)).toEqual(["volume.tar"])
  })

  it("résout une stratégie par défaut pour chaque type de cible", () => {
    expect(defaultStrategyFor("postgres")?.id).toBe("postgres.pg_dump")
    expect(defaultStrategyFor("mysql")?.id).toBe("mysql.mysqldump")
    expect(defaultStrategyFor("mongodb")?.id).toBe("mongodb.mongodump")
    expect(defaultStrategyFor("redis")?.id).toBe("redis.rdb")
    expect(defaultStrategyFor("volume")?.id).toBe("volume.tar")
  })

  it("rejette un identifiant inconnu", () => {
    expect(() => getStrategy("oracle.exp")).toThrow(/stratégie inconnue/)
  })

  it("la table partagée utilisée par le front correspond au registry", () => {
    for (const [kind, id] of Object.entries(BACKUP_STRATEGY_BY_KIND)) {
      expect(defaultStrategyFor(kind as BackupTargetKind)?.id, kind).toBe(id)
      expect(getStrategy(id).targetKind, kind).toBe(kind)
    }
  })
})

describe("découplage du moteur", () => {
  it("le moteur ne connaît ni rclone ni une stratégie concrète", () => {
    for (const file of ["engine/lifecycle.ts", "engine/run-store.ts"]) {
      const source = readFileSync(path.join(ROOT, file), "utf8")
      expect(source, file).not.toMatch(/rclone/i)
      expect(source, file).not.toMatch(/strategies\/(postgres|mysql|mongodb|redis|volume)/)
    }
  })

  it("seule la couche storage parle de rclone", () => {
    for (const file of ["engine/lifecycle.ts", "manifest.ts"]) {
      const source = readFileSync(path.join(ROOT, file), "utf8")
      expect(source, file).not.toMatch(/rclone/i)
    }
  })
})
