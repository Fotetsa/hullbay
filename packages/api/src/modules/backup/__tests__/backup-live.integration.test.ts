import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { postgresStrategy } from "../strategies/postgres"
import { mysqlStrategy } from "../strategies/mysql"
import { mongodbStrategy } from "../strategies/mongodb"
import { redisStrategy } from "../strategies/redis"
import { volumeStrategy } from "../strategies/volume"
import type { StrategyTarget } from "../strategies/types"
import { buildRcloneRemoteString } from "../storage/remote-string"
import { obscureSecret } from "../storage/obscure"

/**
 * Tests LIVE des stratégies : vrais moteurs, vrai binaire de l'image runner.
 *
 * Exécution opt-in (`BACKUP_LIVE=1`) car ils démarrent des conteneurs Docker.
 * Le job CI dédié les active avec les services éphémères ; en local, l'image
 * `hullbay-backup-runner:smoke` doit être construite au préalable.
 *
 * Aucun skip silencieux : le motif d'inactivation est explicite dans le nom du
 * describe.
 */

const LIVE = process.env.BACKUP_LIVE === "1"
const IMAGE = process.env.BACKUP_RUNNER_IMAGE ?? "hullbay-backup-runner:smoke"
const PASSWORD = "live-smoke-password"

const PG_PORT = 55432
const MYSQL_PORT = 53306
const MONGO_PORT = 57017
const REDIS_PORT = 56379
const MINIO_PORT = 59000
const SFTP_PORT = 52222

const containers: string[] = []
let root = ""

function docker(args: string[], input?: Buffer): Buffer {
  return execFileSync("docker", args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  })
}

function dockerText(args: string[], input?: Buffer): string {
  return docker(args, input).toString("utf8")
}

function start(name: string, args: string[]) {
  docker(["run", "-d", "--rm", "--name", name, ...args])
  containers.push(name)
}

function waitFor(check: () => boolean, label: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (check()) return
    } catch {
      // pas encore prêt
    }
    execFileSync("sleep", ["1"])
  }
  throw new Error(`timeout en attendant ${label}`)
}

function secretFile(name: string, content: string): string {
  const file = path.join(root, name)
  writeFileSync(file, content, { mode: 0o644 })
  chmodSync(file, 0o644)
  return file
}

/** Exécute un script de stratégie dans l'image runner (même code qu'en prod). */
function runPlan(
  script: string,
  env: Record<string, string>,
  secrets: Record<string, string> = {},
  mounts: string[] = [],
): Buffer {
  const args = ["run", "--rm", "--network", "host", "-i"]
  const finalEnv = { ...env }
  if (secrets.db_password) finalEnv.DB_PASSWORD_FILE = "/run/secrets/db_password"
  for (const [key, value] of Object.entries(finalEnv)) args.push("-e", `${key}=${value}`)
  for (const [name, file] of Object.entries(secrets)) {
    args.push("-v", `${file}:/run/secrets/${name}:ro`)
  }
  for (const mount of mounts) args.push("-v", mount)
  args.push(IMAGE, "bash", "-c", script)
  return docker(args)
}

function target(kind: StrategyTarget["kind"], port: number, database: string): StrategyTarget {
  return {
    nodeId: `n-${kind}`,
    name: `${kind}-live`,
    kind,
    engine: kind,
    engineVersion: kind === "mongodb" ? "6" : kind === "mysql" ? "8" : "16",
    host: "127.0.0.1",
    port,
    database,
    username: kind === "mongodb" ? "root" : kind === "mysql" ? "root" : "postgres",
    passwordSecretRef: "db_password",
  }
}

describe.skipIf(!LIVE)("stratégies live (Docker)", () => {
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "hullbay-live-"))
    secretFile("db_password", PASSWORD)

    start("hullbay-live-pg", [
      "-e",
      `POSTGRES_PASSWORD=${PASSWORD}`,
      "-e",
      "POSTGRES_DB=orders",
      "-p",
      `${PG_PORT}:5432`,
      "postgres:16-alpine",
    ])
    start("hullbay-live-mysql", [
      "-e",
      `MYSQL_ROOT_PASSWORD=${PASSWORD}`,
      "-e",
      "MYSQL_DATABASE=billing",
      "-p",
      `${MYSQL_PORT}:3306`,
      "mysql:8",
    ])
    start("hullbay-live-mongo", [
      "-e",
      "MONGO_INITDB_ROOT_USERNAME=root",
      "-e",
      `MONGO_INITDB_ROOT_PASSWORD=${PASSWORD}`,
      "-p",
      `${MONGO_PORT}:27017`,
      "mongo:6",
    ])
    start("hullbay-live-redis", [
      "-p",
      `${REDIS_PORT}:6379`,
      "redis:7-alpine",
      "redis-server",
      "--requirepass",
      PASSWORD,
    ])
    // Serveur S3 local fourni par l'image runner elle-même : aucune dépendance
    // à une image tierce (MinIO n'est plus distribué sur Docker Hub), et le
    // protocole exercé reste S3 (rcat/hashsum/moveto).
    start("hullbay-live-s3", [
      "-p",
      `${MINIO_PORT}:59000`,
      IMAGE,
      "bash",
      "-c",
      "mkdir -p /tmp/s3data && exec rclone serve s3 --addr :59000 --auth-key minio,minio-secret /tmp/s3data",
    ])
    start("hullbay-live-sftp", [
      "-p",
      `${SFTP_PORT}:22`,
      "-e",
      `SFTP_USERS=backup:${PASSWORD}:::upload`,
      "atmoz/sftp:alpine",
    ])
  }, 120_000)

  afterAll(() => {
    for (const name of containers) {
      try {
        docker(["rm", "-f", name])
      } catch {
        // déjà arrêté
      }
    }
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it("PostgreSQL : dump streamé, restaurable et complet", () => {
    // pg_isready répond pendant l'initialisation (serveur temporaire) : on
    // attend que la base applicative soit réellement créée et interrogeable.
    waitFor(
      () =>
        dockerText([
          "exec",
          "hullbay-live-pg",
          "psql",
          "-U",
          "postgres",
          "-d",
          "orders",
          "-tAc",
          "select 1",
        ]).trim() === "1",
      "postgres",
    )
    dockerText([
      "exec",
      "hullbay-live-pg",
      "psql",
      "-U",
      "postgres",
      "-d",
      "orders",
      "-c",
      "create table items(id serial primary key, label text); insert into items(label) values ('a'),('b'),('c');",
    ])

    const plan = postgresStrategy.backup(target("postgres", PG_PORT, "orders"))
    const payload = runPlan(
      plan.extractionScript,
      { SRC_HOST: "127.0.0.1", SRC_PORT: String(PG_PORT), SRC_USER: "postgres", SRC_DB: "orders" },
      { db_password: secretFile("pg_password", PASSWORD) },
    )
    expect(payload.length).toBeGreaterThan(0)

    dockerText(["exec", "hullbay-live-pg", "createdb", "-U", "postgres", "orders_restored"])
    docker(
      ["exec", "-i", "hullbay-live-pg", "bash", "-c", "gunzip -c | psql -q -U postgres -d orders_restored"],
      payload,
    )
    const count = dockerText([
      "exec",
      "hullbay-live-pg",
      "psql",
      "-tAc",
      "select count(*) from items",
      "-U",
      "postgres",
      "-d",
      "orders_restored",
    ]).trim()
    expect(count).toBe("3")
  }, 120_000)

  it("MySQL : dump --single-transaction restaurable", () => {
    // `mysqladmin ping` répond "alive" pendant l'initialisation du datadir :
    // on attend une vraie requête authentifiée sur la base applicative.
    waitFor(
      () =>
        dockerText([
          "exec",
          "hullbay-live-mysql",
          "mysql",
          "-uroot",
          `-p${PASSWORD}`,
          "billing",
          "-e",
          "select 1",
        ]).includes("1"),
      "mysql",
    )
    dockerText([
      "exec",
      "hullbay-live-mysql",
      "mysql",
      "-uroot",
      `-p${PASSWORD}`,
      "billing",
      "-e",
      "create table invoices(id int primary key auto_increment, amount int); insert into invoices(amount) values (10),(20);",
    ])

    const plan = mysqlStrategy.backup(target("mysql", MYSQL_PORT, "billing"))
    const payload = runPlan(
      plan.extractionScript,
      { SRC_HOST: "127.0.0.1", SRC_PORT: String(MYSQL_PORT), SRC_USER: "root", SRC_DB: "billing" },
      { db_password: secretFile("mysql_password", PASSWORD) },
    )
    expect(payload.length).toBeGreaterThan(0)

    // `--databases` inclut CREATE DATABASE/USE : on restaure dans la base
    // d'origine après l'avoir vidée, pas dans un schéma tiers.
    dockerText([
      "exec",
      "hullbay-live-mysql",
      "mysql",
      "-uroot",
      `-p${PASSWORD}`,
      "-e",
      "drop database billing; create database billing;",
    ])
    docker(
      [
        "exec",
        "-i",
        "hullbay-live-mysql",
        "bash",
        "-c",
        `gunzip -c | mysql -uroot -p${PASSWORD}`,
      ],
      payload,
    )
    const count = dockerText([
      "exec",
      "hullbay-live-mysql",
      "mysql",
      "-N",
      "-uroot",
      `-p${PASSWORD}`,
      "billing",
      "-e",
      "select count(*) from invoices;",
    ]).trim()
    expect(count).toBe("2")
  }, 180_000)

  it("MongoDB : archive gzip restaurable", () => {
    waitFor(
      () => dockerText(["exec", "hullbay-live-mongo", "mongosh", "--quiet", "--eval", "db.runCommand({ping:1}).ok"]).includes("1"),
      "mongodb",
    )
    dockerText([
      "exec",
      "hullbay-live-mongo",
      "mongosh",
      "mongodb://root:live-smoke-password@127.0.0.1:27017/events?authSource=admin",
      "--quiet",
      "--eval",
      "db.visits.insertMany([{path:'/a'},{path:'/b'}])",
    ])

    const plan = mongodbStrategy.backup(target("mongodb", MONGO_PORT, "events"))
    const payload = runPlan(
      plan.extractionScript,
      { SRC_HOST: "127.0.0.1", SRC_PORT: String(MONGO_PORT), SRC_USER: "root", SRC_DB: "events" },
      { db_password: secretFile("mongo_password", PASSWORD) },
    )
    expect(payload.length).toBeGreaterThan(0)

    dockerText([
      "exec",
      "hullbay-live-mongo",
      "mongosh",
      "mongodb://root:live-smoke-password@127.0.0.1:27017/events?authSource=admin",
      "--quiet",
      "--eval",
      "db.dropDatabase()",
    ])
    const archive = path.join(root, "mongo.archive.gz")
    writeFileSync(archive, payload)
    docker([
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${archive}:/tmp/archive.gz:ro`,
      IMAGE,
      "bash",
      "-c",
      'mongorestore --archive --gzip --uri "mongodb://root:live-smoke-password@127.0.0.1:57017/?authSource=admin" < /tmp/archive.gz',
    ])
    const count = dockerText([
      "exec",
      "hullbay-live-mongo",
      "mongosh",
      "mongodb://root:live-smoke-password@127.0.0.1:27017/events?authSource=admin",
      "--quiet",
      "--eval",
      "db.visits.countDocuments()",
    ]).trim()
    expect(count).toBe("2")
  }, 180_000)

  it("Redis : RDB streamé et valide", () => {
    waitFor(
      () => dockerText(["exec", "hullbay-live-redis", "redis-cli", "-a", PASSWORD, "ping"]).includes("PONG"),
      "redis",
    )
    dockerText(["exec", "hullbay-live-redis", "redis-cli", "-a", PASSWORD, "set", "greeting", "hello"])

    const plan = redisStrategy.backup(target("redis", REDIS_PORT, "0"))
    const payload = runPlan(
      plan.extractionScript,
      { SRC_HOST: "127.0.0.1", SRC_PORT: String(REDIS_PORT) },
      { db_password: secretFile("redis_password", PASSWORD) },
    )
    expect(payload.length).toBeGreaterThan(0)

    const rdb = path.join(root, "dump.rdb")
    writeFileSync(rdb, execFileSync("gzip", ["-dc"], { input: payload }))
    const check = dockerText([
      "run",
      "--rm",
      "-v",
      `${rdb}:/data/dump.rdb:ro`,
      "redis:7-alpine",
      "redis-check-rdb",
      "/data/dump.rdb",
    ])
    expect(check).toMatch(/RDB looks OK|checksum OK/i)
  }, 120_000)

  it("Volume : archive tar restaurable avec espaces dans le chemin", () => {
    const source = path.join(root, "source dir")
    mkdirSync(source, { recursive: true })
    writeFileSync(path.join(source, "notes.txt"), "contenu")
    writeFileSync(path.join(source, "fichier avec espaces.txt"), "ok")

    const plan = volumeStrategy.backup({
      ...target("volume", 0, "volume"),
      mountPath: "/data",
    })
    const payload = runPlan(plan.extractionScript, {}, {}, [`${source}:/data:ro`])

    const archive = path.join(root, "volume.tar.gz")
    writeFileSync(archive, payload)
    const restored = path.join(root, "restored")
    mkdirSync(restored)
    execFileSync("tar", ["-xzf", archive, "-C", restored])
    expect(readFileSync(path.join(restored, "notes.txt"), "utf8")).toBe("contenu")
    expect(readFileSync(path.join(restored, "fichier avec espaces.txt"), "utf8")).toBe("ok")
  }, 60_000)

  it("rclone/S3 : rcat, relecture et moveto (commit atomique)", () => {
    const env = {
      RCLONE_CONFIG_S3_TYPE: "s3",
      RCLONE_CONFIG_S3_PROVIDER: "Other",
      RCLONE_CONFIG_S3_ENDPOINT: `http://127.0.0.1:${MINIO_PORT}`,
      RCLONE_CONFIG_S3_ACCESS_KEY_ID: "minio",
      RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: "minio-secret",
      RCLONE_CONFIG_S3_FORCE_PATH_STYLE: "true",
    }
    const run = (script: string) => runPlan(script, env)

    waitFor(
      () => {
        try {
          run("rclone lsd s3:")
          return true
        } catch {
          return false
        }
      },
      "minio",
    )

    run("rclone mkdir s3:bucket")
    // MinIO/S3 ne stocke pas de sha256 natif : on vérifie l'intégrité du flux
    // par relecture + comparaison à l'empreinte locale (le runner, lui, dégrade
    // la vérification en taille quand le backend n'expose pas de hash).
    const expected = execFileSync("sha256sum", [], { input: "hello backup" })
      .toString("utf8")
      .split(" ")[0]
    const actual = run("printf 'hello backup' | rclone rcat s3:bucket/staging/payload && rclone cat s3:bucket/staging/payload | sha256sum | awk '{print $1}'")
      .toString("utf8")
      .trim()
    expect(actual).toBe(expected)

    run("rclone moveto s3:bucket/staging/payload s3:bucket/final/payload")
    const content = run("rclone cat s3:bucket/final/payload").toString("utf8")
    expect(content).toBe("hello backup")

    const missing = run("rclone lsf s3:bucket/staging").toString("utf8").trim()
    expect(missing).toBe("")
  }, 120_000)

  it("SFTP : mot de passe obscurci et transfert réel", () => {
    waitFor(
      () => {
        try {
          dockerText(["exec", "hullbay-live-sftp", "true"])
          return true
        } catch {
          return false
        }
      },
      "sftp",
      60_000,
    )

    // L'algorithme local doit être relu par le vrai binaire rclone.
    const obscured = obscureSecret(PASSWORD)
    const revealed = dockerText(["run", "--rm", IMAGE, "rclone", "reveal", obscured]).trim()
    expect(revealed).toBe(PASSWORD)

    const remote = buildRcloneRemoteString({
      protocol: "sftp",
      config: {
        protocol: "sftp",
        host: "127.0.0.1",
        port: SFTP_PORT,
        username: "backup",
        password: PASSWORD,
      },
      basePath: "upload/backups",
    })
    const run = (script: string) => runPlan(script, { REMOTE: remote })

    run('printf "sftp payload" | rclone rcat "$REMOTE/payload"')
    expect(run('rclone cat "$REMOTE/payload"').toString("utf8")).toBe("sftp payload")
    run('rclone moveto "$REMOTE/payload" "$REMOTE/final/payload"')
    expect(run('rclone lsf "$REMOTE/final"').toString("utf8").trim()).toBe("payload")
  }, 120_000)
})
