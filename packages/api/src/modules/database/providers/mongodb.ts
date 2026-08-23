import { createHash } from "node:crypto"
import { effectiveReplicas } from "../topology.js"
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
 * Provider MongoDB — slice verticale .
 *
 * ── SINGLE : `mongo:<version>` + réseau + volume data + healthcheck mongosh.
 *
 * ── HA : replica set (RS), un service par membre (replicas=1, DNS individuel
 *    boz_<slug>_<db>-<i>), keyfile partagée (config-secret interne). Le seed
 *    (membre 0, priorité la plus haute) initialise le RS — idempotent
 *    (rs.initiate quand jamais configuré). Les autres membres rejoignent via
 *    --replSet + heartbeat (config propagée par le solveur RS, pas de seed list).
 *
 * ── SÉCURITÉ : mot de passe applicatif JAMAIS dans labels/env/cmd.
 *    Chemin de connexion fourni : cache (DATABASE_HOST/PORT/…), PAS d'URI
 *    complète en clair ; l'app construit son URI au runtime si besoin.
 *
 * NOTE DE VALIDATION : le join RS réel (heartbeat, keyfile) est à valider au
 *   lab live — l'expansion reste pure, déterministe et testée.
 */

const MONGO_PORT = 27017
const DATA_MOUNT_PATH = "/data/db"
const KEY_MOUNT_PATH = "/run/secrets"
const MONGO_DEFAULT_RESOURCES = { cpus: 0.5, memMb: 512 }

/** Champ sectionné de derivedInternalSecret (stabilité des chemins de dériv.). */
const FIELD_MONGO_KEY = "mongo-keyfile"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

/** Valeur interne déterministe (pureté de l'expansion). */
function derivedInternalSecret(ctx: ExpansionContext, field: string): string {
  return createHash("sha256").update(`${ctx.parentNodeId}:${field}`).digest("hex").slice(0, 24)
}

/**
 * Nom du replica set  — déterministe, groupé par nœud database.
 * Charset sûr : [A-Za-z0-9_-] (replSetName ne tolère pas '/', '.', '..').
 */
function replicaSetName(ctx: ExpansionContext): string {
  return `rs_${slugify(ctx.parentNode.name)}_${hash8(ctx.parentNodeId)}`
}

/** Host DNS d'un membre : boz_<slug>_<db>-<i> (un service par membre). */
function memberHost(ctx: ExpansionContext, index: number): string {
  return `boz_${ctx.projectSlug}_${slugify(ctx.parentNode.name)}-${index + 1}`
}

/** Env d'un membre : admin root créé par l'entrypoint, mot de passe en fichier. */
function mongoEnv(config: DatabaseConfig): Record<string, string> {
  return {
    MONGO_INITDB_ROOT_USERNAME: config.credentials.username,
    MONGO_INITDB_ROOT_PASSWORD_FILE: `/run/secrets/${config.credentials.passwordSecretRef!}`,
    MONGO_INITDB_DATABASE: config.credentials.database,
  }
}

/** Healthcheck mongosh : ping admin (auth) — mot de passe lu au runtime.
 *  L'auth se fait DANS l'éval (cat du fichier monté) — jamais de -p argv
 *  visible dans `ps`. */
function mongoHealthcheck(config: DatabaseConfig, checkRole: boolean) {
  const pw = `cat("/run/secrets/${config.credentials.passwordSecretRef!}").trim()`
  const auth = `const __p=${pw}; if (!db.getSiblingDB("admin").auth("${config.credentials.username}", __p)) quit(3); `
  const probe = checkRole
    ? `const h=db.hello(); if(!h.ok) quit(1); if(!(h.isWritablePrimary||h.secondary)) quit(1);`
    : `db.adminCommand({ping:1}).ok !== 1 && quit(1); quit(0);`
  return {
    test: [
      "CMD-SHELL",
      `mongosh --quiet --host 127.0.0.1 --port ${MONGO_PORT} --eval '${auth}${probe}'`,
    ],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/**
 * Init RS — config-secret montée au SEED (member 0) et jouée par le wrapper
 * contre le VRAI mongod (mongosh localhost, auth root), APRÈS démarrage réel —
 * PAS via /docker-entrypoint-initdb.d/ : l'entrypoint officiel exécute ces
 * scripts sur un serveur TEMPORAIRE qui a été unveiled de --replSet/--keyFile
 * dès que MONGO_INITDB_ROOT_USERNAME est défini (cf. docker-entrypoint.sh).
 * rs.initiate idempotent (✓ si déjà configuré).
 */
function replicaSetInitJs(config: DatabaseConfig, ctx: ExpansionContext): string {
  const members = Array.from({ length: effectiveReplicas(config) }, (_, i) => {
    const priority = i === 0 ? 3 : 1
    return `    { _id: ${i}, host: "${memberHost(ctx, i)}:${MONGO_PORT}", priority: ${priority} }`
  }).join(",\n")
  return `// Généré par le provider mongodb (spec §15, déterministe).
  // Joué par le seed via mongosh contre le vrai mongod (localhost, auth root).
  const rsName = "${replicaSetName(ctx)}";

  // Auth root locale — mot de passe LU du fichier monté, jamais en argv (§23).
  const __pw = cat("/run/secrets/${config.credentials.passwordSecretRef!}").trim();
  if (!db.getSiblingDB("admin").auth("${config.credentials.username}", __pw)) {
    throw new Error("root auth failed (init)");
  }

  // Sur un nœud frais, rs.status() LÈVE (pas de replset config reçu) : on
  // initialise dans le catch — journalisé, pas avalé (échec = échec fatal).
  let configured = false;
  try {
    const s = rs.status();
    configured = s && s.ok === 1;
  } catch (e) {
    print("rs.status error (fresh node expected): " + e);
  }

  if (configured) {
    print("replica set already configured");
  } else {
    rs.initiate({
      _id: rsName,
      version: 1,
      members: [
${members}
    ]
    });
    print("replica set initiated");
  }
`
}

/** Charge utile du fichier keyfile (config-secret ) — partagée par les membres. */
function keyFileValue(ctx: ExpansionContext): string {
  return derivedInternalSecret(ctx, FIELD_MONGO_KEY)
}

/**
 * Wrapper d'entrée d'un membre HA.
 *
 * ── NON-SEED : copie la keyfile (les secrets Swarm sont montés 0444 → mongod
 *    refuse « too open »), puis exec l'entrypoint officiel `mongod --replSet
 *    --keyFile`. Son initdb crée le root user (datadir vide) et son vrai mongod
 *    démarre avec replSet+keyFile : il rejoint le RS dès que le seed l'initie
 *    (heartbeat → config apprise, pas besoin de seed-list).
 *
 * ── SEED : même copie de keyfile, MAIS l'initdb de l'entrypoint tourne sur un
 *    serveur temporaire strippé de --replSet/--keyFile → impossible d'y initier
 *    le RS. À la place : lance l'entrypoint (avec replSet+keyFile) en arrière-plan,
 *    attend le vrai mongod UP (auth root, mdp fichier), joue l'init JS via
 *    mongosh localhost (rs.initiate idempotent, §15), puis wait — le conteneur
 *    vit tant que mongod vit.
 */
function mongoSeedCmd(
  ctx: ExpansionContext,
  keySecretName: string,
  initSecretName: string
): string[] {
  const rs = replicaSetName(ctx)
  const username = ctx.parentNode.config.credentials.username
  const passwordSecretRef = ctx.parentNode.config.credentials.passwordSecretRef!
  const args = ["--replSet", rs, "--keyFile", "/tmp/mongo-keyfile", "--bind_ip_all", "--port", String(MONGO_PORT)]
  const authEval =
    `const p=cat("/run/secrets/${passwordSecretRef}").trim();` +
    `if (db.getSiblingDB("admin").auth("${username}", p) && db.hello().ok) quit(0);` +
    `quit(1)`
  return [
    "/bin/sh",
    "-c",
    [
      "set -e",
      `cp /run/secrets/${keySecretName} /tmp/mongo-keyfile && chmod 600 /tmp/mongo-keyfile`,
      `docker-entrypoint.sh mongod ${args.join(" ")} &`,
      "MONGOD_PID=$!",
      "tries=60",
      `until mongosh --quiet --host 127.0.0.1 --port ${MONGO_PORT} --eval '${authEval}' >/dev/null 2>&1; do`,
      `  tries=$((tries - 1)); [ "$tries" -le 0 ] && { echo "mongod UP-await timed out" >&2; kill "$MONGOD_PID"; exit 1; }; sleep 1`,
      "done",
      // Init RS depuis localhost. Pas de `|| true` : un échec d'init doit faire
      // sortir le conteneur (Swarm redémarre et réessaie), pas masquer la panne.
      `mongosh --quiet --host 127.0.0.1 --port ${MONGO_PORT} < /run/secrets/${initSecretName}`,
      "wait \"$MONGOD_PID\"",
    ].join("\n"),
  ]
}

function mongoMemberCmd(
  ctx: ExpansionContext,
  keySecretName: string,
  initSecretName: string | null
): string[] {
  if (initSecretName !== null) {
    return mongoSeedCmd(ctx, keySecretName, initSecretName)
  }
  const rs = replicaSetName(ctx)
  const args = ["--replSet", rs, "--keyFile", "/tmp/mongo-keyfile", "--bind_ip_all", "--port", String(MONGO_PORT)]
  return [
    "/bin/sh",
    "-c",
    [
      "set -e",
      `cp /run/secrets/${keySecretName} /tmp/mongo-keyfile && chmod 600 /tmp/mongo-keyfile`,
      `exec docker-entrypoint.sh mongod ${args.join(" ")}`,
    ].join("\n"),
  ]
}

// ── Connexions (spec §17) ────────────────────────────────────────────────────

export function mongoConnections(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ConnectionEndpoint[] {
  const passwordSecretRef = config.credentials.passwordSecretRef!!
  const database = config.credentials.database
  const username = config.credentials.username

  if (config.mode !== "ha") {
    const host = `boz_${ctx.projectSlug}_${slugify(ctx.parentNode.name)}`
    return [
      {
        role: "writer",
        host,
        port: MONGO_PORT,
        database,
        username,
        passwordSecretRef,
        env: {
          DATABASE_HOST: host,
          DATABASE_PORT: String(MONGO_PORT),
          DATABASE_USER: username,
          DATABASE_NAME: database,
          DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
          DATABASE_SCHEME: "mongodb",
        },
      },
    ]
  }

  // HA : connection RS-aware (spec §15) — liste des membres, PAS de VIP.
  const hosts = Array.from(
    { length: effectiveReplicas(config) },
    (_, i) => `${memberHost(ctx, i)}:${MONGO_PORT}`
  ).join(",")
  const host = memberHost(ctx, 0)
  return [
    {
      role: "writer",
      host,
      port: MONGO_PORT,
      database,
      username,
      passwordSecretRef,
      env: {
        DATABASE_URL: `mongodb://${hosts}/${database}?replicaSet=${replicaSetName(ctx)}&authSource=admin`,
        DATABASE_HOST: host,
        DATABASE_PORT: String(MONGO_PORT),
        DATABASE_USER: username,
        DATABASE_NAME: database,
        DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
        DATABASE_SCHEME: "mongodb",
        DATABASE_REPLICA_SET: replicaSetName(ctx),
      },
    },
  ]
}

// ── Expansions ────────────────────────────────────────────────────────────────

function memberContainer(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  keySecretName: string,
  initSecretName: string
): GeneratedResource & { kind: "container" } {
  const name = slugify(ctx.parentNode.name)
  const isSeed = index === 0
  const secrets = [
    { secretName: config.credentials.passwordSecretRef!! },
    { secretName: keySecretName },
  ]
  if (isSeed) {
    secrets.push({ secretName: initSecretName })
  }
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::member::${index}`,
    name: `${name}-${index + 1}`,
    role: "member",
    index,
    config: {
      image: "mongo",
      tag: config.version,
      env: mongoEnv(config),
      secrets,
      cmd: mongoMemberCmd(ctx, keySecretName, isSeed ? initSecretName : null),
      resources: config.resources ?? MONGO_DEFAULT_RESOURCES,
      // §24 : membre HA = rôle PRIMARY/SECONDARY ; single = ping.
      healthcheck: mongoHealthcheck(config, config.mode === "ha"),
      placement: { constraints: [], spreadOver: ["node.id"] },
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

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
  volumeConfig?: DatabaseConfig["storage"]
): GeneratedResource {
  const name = slugify(ctx.parentNode.name)
  // HA : volumes managés par membre (local). Single : honore la config storage.
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
    name: `${name}-data-${index + 1}`,
    role: "volume",
    index,
    data: true,
    config,
  }
}

function expandMongoSingle(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ExpandedDatabase {
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
      image: "mongo",
      tag: config.version,
      env: mongoEnv(config),
      secrets: [{ secretName: config.credentials.passwordSecretRef!! }],
      resources: config.resources ?? MONGO_DEFAULT_RESOURCES,
      healthcheck: mongoHealthcheck(config, false),
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
    connections: mongoConnections(config, ctx),
    generatedSecrets: [],
  }
}

function expandMongoHa(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  const replicas = effectiveReplicas(config)

  const name = slugify(ctx.parentNode.name)
  const networkId = `db::${ctx.parentNodeId}::network::0`
  const generatedSecrets: { name: string; data: string }[] = []

  const key = keyFileValue(ctx)
  const keySecretName = `${name}-mongo-keyfile-${hash8(key)}`
  generatedSecrets.push({ name: keySecretName, data: key })

  const network: GeneratedResource = networkResource(ctx)

  const resources: GeneratedResource[] = []
  const edges: ExpandedDatabase["edges"] = []

  // Script d'init du RS : joué une fois par le seed (entrypoint, datadir vide).
  const initJs = replicaSetInitJs(config, ctx)
  const initSecretName = `${name}-mongo-rs-init-${hash8(initJs)}`
  generatedSecrets.push({ name: initSecretName, data: initJs })

  for (let i = 0; i < replicas; i++) {
    const member = memberContainer(config, ctx, i, keySecretName, initSecretName)
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
  resources.push(network)

  return {
    resources,
    edges,
    connections: mongoConnections(config, ctx),
    generatedSecrets,
  }
}

/** Dispatch single/HA (interface DatabaseProvider.expand). */
export function expandMongo(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  return config.mode === "ha" ? expandMongoHa(config, ctx) : expandMongoSingle(config, ctx)
}

export const mongoProvider: DatabaseProvider = {
  engine: "mongodb",
  validate(config: DatabaseConfig): void {
    if (config.engine !== "mongodb") {
      throw new DatabaseValidationError([`provider mongodb : moteur ${config.engine} inattendu`])
    }
    validateDatabaseConfig(config)
    if (!config.credentials.passwordSecretRef) {
      throw new DatabaseValidationError([
        "passwordSecretRef requis : sélectionne le secret Docker du mot de passe (module Secrets).",
      ])
    }
    if (config.mode === "ha" && config.storage.external) {
      throw new DatabaseValidationError([
        "mongodb/ha : volume externe non supporté en HA — l'externalName serait monté par tous les membres sur /data/db (corruption). Utilise les volumes managés par membre.",
      ])
    }
  },
  expand: expandMongo,
  connection: mongoConnections,
}