import { effectiveConsensus, effectiveReplicas } from "../topology.js"
import { validateDatabaseConfig } from "../validation.js"
import { DatabaseValidationError } from "../validation.js"
import type {
  DatabaseConfig,
  DatabaseProvider,
  ExpandedDatabase,
  ExpansionContext,
  ConnectionEndpoint,
  GeneratedResource,
} from "../types.js"

/**
 * Provider Redis — slice verticale.
 *
 * ── SINGLE : `redis:<version>` + réseau + volume data + healthcheck AUTH+PING.
 *
 * ── HA : master (membre 0) + réplicas (data-replicas, `replicaof` du master) +
 *    Sentinel (consensus DÉCOUPLÉ — §16 : redis replicas ≠ sentinel replicas,
 *    `topology.consensusReplicas` indépendant). Sentinel = config-secret
 *    (sentinel.conf) montée sur chaque membre du quorum. Pas de volume Sentinel :
 *    état transitoire, re-découvert via l'interrogation des data members.
 *
 * ── SÉCURITÉ : le mot de passe applicatif n'est JAMAIS dans labels/env/cmd
 *    ni dans aucun config-secret généré. requirepass/masterauth = substitués AU
 *    RUNTIME par le wrapper (`$(cat /run/secrets/<ref>)` — la valeur n'apparaît
 *    ni dans docker inspect ni dans l'env). Sentinel : auth-pass rendu au runtime
 *    (heredoc dans le conteneur, valeur depuis le fichier secret monté). Les
 *    healthchecks redis passent par redis-cli avec REDISCLI_AUTH (jamais de
 *    mot de passe en argv).
 *
 * NOTE DE VALIDATION : failover réel (quorum, promotion réplica) à valider au
 *   lab live — l'expansion reste pure, déterministe et testée.
 */

const REDIS_PORT = 6379
const SENTINEL_PORT = 26379
const DATA_MOUNT_PATH = "/data"
const REDIS_DEFAULT_RESOURCES = { cpus: 0.5, memMb: 256 }
const SENTINEL_DEFAULT_RESOURCES = { cpus: 0.15, memMb: 128 }

/** Nom du master surveillé par Sentinel — fixe (réseau overlay par topologie). */
const MASTER_NAME = "mymaster"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Host DNS d'un data member : boz_<slug>_<db>-<i> (membre 0 = master). */
function memberHost(ctx: ExpansionContext, index: number): string {
  return `boz_${ctx.projectSlug}_${slugify(ctx.parentNode.name)}-${index + 1}`
}

/** Host DNS d'un Sentinel : boz_<slug>_<db>-sentinel-<i>. */
function sentinelHost(ctx: ExpansionContext, index: number): string {
  return `boz_${ctx.projectSlug}_${slugify(ctx.parentNode.name)}-sentinel-${index + 1}`
}

/**
 * Wrapper de démarrage d'un data member. Le mot de passe (requirepass +
 * masterauth sur TOUS les membres, y compris le master : utile après
 * promotion/démotion) est lu du fichier secret monté AU RUNTIME — jamais de
 * valeur statique dans la cmd.
 */
function redisMemberCmd(config: DatabaseConfig, index: number, peers: string[]): string[] {
  const pwRef = config.credentials.passwordSecretRef!
  const masterHost = peers[0]
  const flags = [
    `exec redis-server --port ${REDIS_PORT}`,
    "--appendonly yes",
    `--dir ${DATA_MOUNT_PATH}`,
    `--requirepass "$(cat /run/secrets/${pwRef})"`,
    `--masterauth "$(cat /run/secrets/${pwRef})"`,
  ]
  if (index > 0) {
    flags.push(`--replicaof ${masterHost} ${REDIS_PORT}`, "--replica-read-only yes")
  }
  return ["/bin/sh", "-c", flags.join(" ")]
}

/**
 * Healthcheck d'un data member : AUTH+PING par socket TCP brut (/dev/tcp).
 * Le mot de passe est écrit sur le fd à partir du fichier monté — aucune
 * valeur sensible n'apparaît dans `ps` ni dans le test docker inspect.
 */
function redisHealthcheck(config: DatabaseConfig) {
  const pwRef = config.credentials.passwordSecretRef!
  const probe =
    `REDISCLI_AUTH="$(cat /run/secrets/${pwRef})" ` +
    `redis-cli -p ${REDIS_PORT} ping`
  return {
    test: ["CMD", "sh", "-c", probe],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/**
 * Commande d'un Sentinel : rendu de la config au runtime (heredoc) avec le mot
 * de passe appliquif LU du fichier secret monté. Le format Sentinel impose
 * l'auth-pass en clair dans sa config : impossible de le déréférencer via un
 * fichier séparé. La valeur n'apparaît JAMAIS dans une cmd/docker inspect ni
 * dans un config-secret généré — seulement dans /tmp/sentinel.conf du conteneur.
 */
function sentinelCmd(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  quorum: number
): string[] {
  const masterHost = memberHost(ctx, 0)
  const lines = [
    "PW=\"$(cat /run/secrets/" + config.credentials.passwordSecretRef! + ")\"",
    "cat > /tmp/sentinel.conf <<CONF",
    `port ${SENTINEL_PORT}`,
    "bind 0.0.0.0",
    "protected-mode no",
    "requirepass $PW",
    `sentinel monitor ${MASTER_NAME} ${masterHost} ${REDIS_PORT} ${quorum}`,
    `sentinel auth-pass ${MASTER_NAME} $PW`,
    `sentinel down-after-milliseconds ${MASTER_NAME} 5000`,
    `sentinel failover-timeout ${MASTER_NAME} 60000`,
    `sentinel parallel-syncs ${MASTER_NAME} 1`,
    "dir /tmp",
    "CONF",
    "exec redis-server /tmp/sentinel.conf",
    "",
  ].join("\n")
  return ["/bin/sh", "-c", lines]
}

/** Healthcheck Sentinel : master résolu → conteneur sain ; auth via REDISCLI_AUTH (jamais en argv). */
function sentinelHealthcheck(pwRef: string) {
  return {
    test: [
      "CMD",
      "sh",
      "-c",
      `REDISCLI_AUTH="$(cat /run/secrets/${pwRef})" redis-cli -p ${SENTINEL_PORT} sentinel get-master-addr-by-name ${MASTER_NAME}`,
    ],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

// ── Connexions (route vers le master courant via Sentinel) ───

export function redisConnections(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ConnectionEndpoint[] {
  const passwordSecretRef = config.credentials.passwordSecretRef!
  const database = config.credentials.database
  const username = config.credentials.username

  if (config.mode !== "ha") {
    const host = `boz_${ctx.projectSlug}_${slugify(ctx.parentNode.name)}`
    return [
      {
        role: "writer",
        host,
        port: REDIS_PORT,
        database,
        username,
        passwordSecretRef,
        env: {
          DATABASE_HOST: host,
          DATABASE_PORT: String(REDIS_PORT),
          DATABASE_USER: username,
          DATABASE_NAME: database,
          DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
          DATABASE_SCHEME: "redis",
        },
      },
    ]
  }

  // HA : pas de VIP — découverte du master courant par Sentinel. L'app (ex.
  // ioredis) consomme la liste des sentinels + le nom du master pour router les
  // écritures vers le primaire tel que désigné par le quorum .
  const sentinels = Array.from({ length: effectiveConsensus(config) ?? 0 }, (_, i) =>
    `${sentinelHost(ctx, i)}:${SENTINEL_PORT}`
  ).join(",")
  const host = sentinelHost(ctx, 0)
  return [
    {
      role: "writer",
      host,
      port: SENTINEL_PORT,
      database,
      username,
      passwordSecretRef,
      env: {
        DATABASE_HOST: host,
        DATABASE_PORT: String(SENTINEL_PORT),
        DATABASE_USER: username,
        DATABASE_NAME: database,
        DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
        DATABASE_SCHEME: "redis",
        DATABASE_SENTINELS: sentinels,
        DATABASE_PRIMARY_NAME: MASTER_NAME,
      },
    },
  ]
}

// ── Expansions ────────────────────────────────────────────────────────────────

function networkResource(ctx: ExpansionContext): GeneratedResource {
  return {
    kind: "network",
    nodeId: `db::${ctx.parentNodeId}::network::0`,
    name: `${slugify(ctx.parentNode.name)}-net`,
    role: "network",
    index: 0,
    config: { driver: "overlay", internal: false, attachable: true },
  }
}

function volumeResource(
  ctx: ExpansionContext,
  index: number,
  volumeConfig?: DatabaseConfig["storage"],
  name = `${slugify(ctx.parentNode.name)}-data-${index + 1}`,
): GeneratedResource {
  const config = volumeConfig
    ? {
        driver: volumeConfig.driver,
        driverOpts: volumeConfig.driverOpts,
        external: volumeConfig.external,
        externalName: volumeConfig.externalName,
      }
    : { driver: "local", external: false }
  return {
    kind: "volume",
    nodeId: `db::${ctx.parentNodeId}::volume::${index}`,
    name,
    role: "volume",
    index,
    data: true,
    config,
  }
}

function dataMember(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  peers: string[],
): GeneratedResource & { kind: "container" } {
  const name = slugify(ctx.parentNode.name)
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::member::${index}`,
    name: `${name}-${index + 1}`,
    role: "member",
    index,
    config: {
      image: "redis",
      tag: config.version,
      cmd: redisMemberCmd(config, index, peers),
      // Les volumes membres REQUIRE /run/secrets du membre.
      secrets: [{ secretName: config.credentials.passwordSecretRef! }],
      resources: config.resources ?? REDIS_DEFAULT_RESOURCES,
      healthcheck: redisHealthcheck(config),
      placement: { constraints: [], spreadOver: ["node.id"] },
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

function sentinelMember(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  quorum: number,
): GeneratedResource & { kind: "container" } {
  const name = slugify(ctx.parentNode.name)
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::consensus::${index}`,
    name: `${name}-sentinel-${index + 1}`,
    role: "consensus",
    index,
    config: {
      image: "redis",
      tag: config.version,
      cmd: sentinelCmd(config, ctx, quorum),
      secrets: [{ secretName: config.credentials.passwordSecretRef! }],
      resources: SENTINEL_DEFAULT_RESOURCES,
      healthcheck: sentinelHealthcheck(config.credentials.passwordSecretRef!),
      placement: { constraints: [], spreadOver: ["node.id"] },
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

function expandRedisSingle(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  if (effectiveReplicas(config) !== 1) {
    throw new DatabaseValidationError([`${config.engine}/single : replicas doit être 1`])
  }

  const name = slugify(ctx.parentNode.name)
  const memberId = `db::${ctx.parentNodeId}::member::0`
  const networkId = `db::${ctx.parentNodeId}::network::0`
  const volumeId = `db::${ctx.parentNodeId}::volume::0`

  const member: GeneratedResource = {
    kind: "container",
    nodeId: memberId,
    name,
    role: "member",
    index: 0,
    config: {
      image: "redis",
      tag: config.version,
      cmd: ["sh", "-c", [
        `exec redis-server --port ${REDIS_PORT}`,
        "--appendonly yes",
        `--dir ${DATA_MOUNT_PATH}`,
        `--requirepass "$(cat /run/secrets/${config.credentials.passwordSecretRef!})"`,
      ].join(" ")],
      secrets: [{ secretName: config.credentials.passwordSecretRef! }],
      resources: config.resources ?? REDIS_DEFAULT_RESOURCES,
      healthcheck: redisHealthcheck(config),
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
  const network: GeneratedResource = networkResource(ctx)
  const volume: GeneratedResource = volumeResource(ctx, 0, config.storage)

  return {
    resources: [member, network, volume],
    edges: [
      { source: memberId, target: networkId, kind: "network" },
      { source: memberId, target: volumeId, kind: "volume", config: { mountPath: DATA_MOUNT_PATH } },
    ],
    connections: redisConnections(config, ctx),
    generatedSecrets: [],
  }
}

function expandRedisHa(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  const replicas = effectiveReplicas(config)
  const sentinelCount = effectiveConsensus(config) ?? 0

  const name = slugify(ctx.parentNode.name)
  const networkId = `db::${ctx.parentNodeId}::network::0`
  // Quorum majoritaire : perdre un sentinel ne bloque pas le failover (3→2, 5→3).
  const quorum = Math.ceil(sentinelCount / 2)
  const generatedSecrets: { name: string; data: string }[] = []

  const network: GeneratedResource = networkResource(ctx)
  const resources: GeneratedResource[] = []
  const edges: ExpandedDatabase["edges"] = []

  const peers = Array.from({ length: replicas }, (_, i) => memberHost(ctx, i))

  for (let i = 0; i < replicas; i++) {
    const member = dataMember(config, ctx, i, peers)
    const volumeId = `db::${ctx.parentNodeId}::volume::${i}`
    resources.push(member)
    resources.push(volumeResource(ctx, i))
    edges.push({ source: member.nodeId, target: networkId, kind: "network" })
    edges.push({
      source: member.nodeId,
      target: volumeId,
      kind: "volume",
      config: { mountPath: DATA_MOUNT_PATH },
    })
  }

  for (let i = 0; i < sentinelCount; i++) {
    const sentinel = sentinelMember(config, ctx, i, quorum)
    resources.push(sentinel)
    edges.push({ source: sentinel.nodeId, target: networkId, kind: "network" })
  }

  resources.push(network)

  return { resources, edges, connections: redisConnections(config, ctx), generatedSecrets }
}

/** Dispatch single/HA (interface DatabaseProvider.expand). */
export function expandRedis(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  return config.mode === "ha" ? expandRedisHa(config, ctx) : expandRedisSingle(config, ctx)
}

export const redisProvider: DatabaseProvider = {
  engine: "redis",
  validate(config: DatabaseConfig): void {
    if (config.engine !== "redis") {
      throw new DatabaseValidationError([`provider redis : moteur ${config.engine} inattendu`])
    }
    validateDatabaseConfig(config)
    if (!config.credentials.passwordSecretRef) {
      throw new DatabaseValidationError([
        "passwordSecretRef requis : sélectionne le secret Docker du mot de passe (module Secrets).",
      ])
    }
    if (config.mode === "ha" && config.storage.external) {
      throw new DatabaseValidationError([
        "redis/ha : volume externe non supporté en HA — l'externalName serait monté par tous les membres sur /data (corruption). Utilise les volumes managés par membre.",
      ])
    }
  },
  expand: expandRedis,
  connection: redisConnections,
}