import { createHash } from "node:crypto"
import { effectiveReplicas, effectiveConsensus } from "../topology.js"
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
 * Provider PostgreSQL.
 *
 * SLICE VERTICALE : single puis HA.
 *
 * ── HA : Patroni + etcd (consensus découplé) + HAProxy (writer/reader) ──────
 * Doc officielle : le montage des variables *_FILE évite tout secret en
 * environnement de service (coherent spec §23 — jamais de mot de passe en clair
 * dans les labels, l'env, le graphe ni les logs).
 *
 * MEMBRES : UN service Docker par membre (boz_<slug>_<db>-<i>, replicas=1),
 * jamais un service répliqué — Swarm assigne le même nom DNS à toutes les tasks
 * d'un service répliqué, ce qui rendrait les membres indistinguables pour le
 * HAProxy/Patroni (adresses individuelles requises pour le quorum).
 *
 * ENDPOINTS : writer + reader déterministes (spec §12). Le writer évalue Patroni
 * REST /primary (HTTP check du backend HAProxy), PAS un health HTTP postgres.
 *
 * PLACEMENT : spread de membre à membre via node.id (Swarm répartit),
 * contrainte node.role==worker. Pas de scheduler maison.
 */

const POSTGRES_PORT = 5432
const PATRONI_REST_PORT = 8008
const ETCD_CLIENT_PORT = 2379
const ETCD_PEER_PORT = 2380
const DATA_MOUNT_PATH = "/var/lib/postgresql/data"
const ETCD_DATA_MOUNT_PATH = "/etcd-data"

/** Défauts de ressources par défaut quand la config n'en précise pas. */
const POSTGRES_DEFAULT_RESOURCES = { cpus: 0.5, memMb: 512 }

/**
 * Images — image Patroni custom hullbay (GHCR), une image par version majeure PG.
 * Tag aligné sur la release hullbay + major PG, ex : `v1.2.4-pg16` (préfixe `v`
 * cohérent avec la convention ghcr, comme l'API `v1.2.4`).
 * `HULLBAY_RELEASE` est INJECTÉ par la CI au build de l'API (ARG → ENV du Dockerfile),
 * depuis le même tag release-please qui tague l'image patroni — une seule source
 * de vérité, aucune valeur à bumper à la main (postgres.ts:54).
 */
const PATRONI_IMAGE = { image: "ghcr.io/fotetsa/hullbay/patroni" }
/**
 * Version de release hullbay courante — injectée par la CI au build de l'API
 * (même valeur `base` qui tague `patroni:<release>-pg<major>`), fallback dev.
 */
const HULLBAY_RELEASE = process.env.HULLBAY_RELEASE ?? "1.2.4"
const ETCD_IMAGE = { image: "quay.io/coreos/etcd", tag: "v3.5.16" }
const HAPROXY_IMAGE = { image: "haproxy", tag: "2.9-alpine" }

/** noms de ressources lisibles → identifiants Docker-valides. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * CONTRAT DE NOMMAGE  : les ressources générées portent des noms
 * SANS préfixe (`catalog`, `catalog-net`, `catalog-data`). Le préfixe
 * `boz_<slug>_` est appliqué au moment du deploy par le workflow existant
 * (resourceName dans deploy-project.ts) — idem pour réseaux et volumes.
 * Le host du connection contract expose donc le nom RÉSOLU complet
 * `boz_<slug>_<node>` : invariante host === `boz_${slug}_${nodeName}`.
 */
export function postgresMemberServiceName(ctx: ExpansionContext): string {
  return `boz_${ctx.projectSlug}_${slugify(ctx.parentNode.name)}`
}

/** Hash court (8 hex) d'un contenu → suffixe de nom versionné de config-secret. */
function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

/**
 * Valeur interne déterministe (réplication Patroni). Dérivée de l'identité du
 * nœud parent — jamais stockée dans un label ni l'env : matérialisée comme
 * Docker Secret de config (generatedSecrets), montée en fichier. La déterminité
 * est exigée par la pureté de l'expansion (§19) ; deux projets distincts ont des
 * nodeId distincts → valeurs distinctes.
 */
function derivedInternalSecret(ctx: ExpansionContext, field: string): string {
  return createHash("sha256").update(`${ctx.parentNodeId}:${field}`).digest("hex").slice(0, 24)
}

function postgresHealthcheck(config: DatabaseConfig) {
  // Forme exec (pas de shell) : les valeurs utilisateur (username/database) ne
  // sont jamais interpolées dans une chaîne shell → pas d'injection possible.
  return {
    test: ["CMD", "pg_isready", "-U", config.credentials.username, "-d", config.credentials.database],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/** Santé Patroni d'un membre (primary = replica = healthy pour Patroni). */
function patroniHealthcheck() {
  // Patroni répond 200 sur /health tant que le membre est sain (quel que soit
  // son rôle). La distinction primary/replica est portée par les checks HTTP du
  // HAProxy (/primary et /replica), pas par le container healthcheck.
  return {
    test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8008/health"],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/** Santé du quorum etcd (etcdctl endpoint health contre soi-même). */
function etcdHealthcheck() {
  return {
    test: ["CMD", "etcdctl", "endpoint", "health"],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/** Santé locale d'un endpoint HAProxy (écoute TCP sur le port postgres). */
function haproxyHealthcheck() {
  return {
    test: ["CMD", "sh", "-c", "nc -z 127.0.0.1 5432"],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/**
 * Placement spread des membres/consensus (spec §10, préférence déterministe).
 * PAS de contrainte node.role==worker : dans Swarm, un manager est aussi worker
 * par défaut (et un cluster mono-nœud est manager+worker). Une contrainte worker
 * rendrait le HA inschedulable sur la config par défaut du produit. Les managers
 * dédiés (rare) se protègent via `availability=drain`, pas via la spec du service.
 */
function haPlacement() {
  return {
    constraints: [] as string[],
    spreadOver: ["node.id"],
  }
}

function postgresEnv(config: DatabaseConfig): Record<string, string> {
  // Le mot de passe n'est jamais dans l'env : monté en fichier
  // (/run/secrets/<secretName>) et lu via POSTGRES_PASSWORD_FILE.
  return {
    POSTGRES_USER: config.credentials.username,
    POSTGRES_DB: config.credentials.database,
    POSTGRES_PASSWORD_FILE: `/run/secrets/${config.credentials.passwordSecretRef!}`,
  }
}

export function postgresConnections(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ConnectionEndpoint[] {
  const passwordSecretRef = config.credentials.passwordSecretRef!
  const database = config.credentials.database
  const username = config.credentials.username

  if (config.mode !== "ha") {
    const host = postgresMemberServiceName(ctx)
    return [
      {
        role: "writer",
        host,
        port: POSTGRES_PORT,
        database,
        username,
        passwordSecretRef,
        // Injection possible SANS valeur sensible : l'app monte le secret et
        // construit son URL avec les morceaux ci-dessous.
        env: {
          DATABASE_HOST: host,
          DATABASE_PORT: String(POSTGRES_PORT),
          DATABASE_USER: username,
          DATABASE_NAME: database,
          DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
          DATABASE_SCHEME: "postgresql",
        },
      },
    ]
  }

  // HA : endpoints writer/reader déterministes — noms de services
  // Swarm distincts, résolus par DNS overlay. Deux entrées de connexion ; l'app
  // les fusionne (réduction dans l'expansion) : DATABASE_* = écriture,
  // DATABASE_READ_* = lecture.
  const base = slugify(ctx.parentNode.name)
  const writerHost = `boz_${ctx.projectSlug}_${base}-writer`
  const readerHost = `boz_${ctx.projectSlug}_${base}-reader`
  return [
    {
      role: "writer",
      host: writerHost,
      port: POSTGRES_PORT,
      database,
      username,
      passwordSecretRef,
      env: {
        DATABASE_HOST: writerHost,
        DATABASE_PORT: String(POSTGRES_PORT),
        DATABASE_USER: username,
        DATABASE_NAME: database,
        DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
        DATABASE_SCHEME: "postgresql",
      },
    },
    {
      role: "reader",
      host: readerHost,
      port: POSTGRES_PORT,
      database,
      username,
      passwordSecretRef,
      env: {
        DATABASE_READ_HOST: readerHost,
        DATABASE_READ_PORT: String(POSTGRES_PORT),
        DATABASE_READ_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
        DATABASE_READ_SCHEME: "postgresql",
      },
    },
  ]
}

/** Config HAProxy du writer : écriture uniquement vers le leader Patroni. */
function haproxyWriterConfig(config: DatabaseConfig, ctx: ExpansionContext): string {
  const name = slugify(ctx.parentNode.name)
  const memberHosts = Array.from(
    { length: effectiveReplicas(config) },
    (_, i) => `boz_${ctx.projectSlug}_${name}-${i + 1}`
  )
  const servers = memberHosts
    .map((h, i) => `  server m${i + 1} ${h}:${POSTGRES_PORT} check port ${PATRONI_REST_PORT}`)
    .join("\n")
  return [
    "global",
    "  daemon",
    "  maxconn 256",
    "defaults",
    "  mode tcp",
    "  timeout connect 5s",
    "  timeout client 30s",
    "  timeout server 30s",
    "frontend write",
    "  bind *:5432",
    "  default_backend writer",
    "backend writer",
    // Le leader se désigne par Patroni REST /primary ( JAMAIS le
    // health HTTP de postgres lui-même). /primary 200 = writable. En mode tcp,
    // server ADDR:PORT est la cible de forward (postgres) ; `check port` pointe
    // le health HTTP (Patroni REST 8008).
    "  option httpchk GET /primary",
    "  http-check expect status 200",
    servers,
    "",
  ].join("\n")
}

/** Config HAProxy du reader : répliques attendues (Patroni /replica). */
function haproxyReaderConfig(config: DatabaseConfig, ctx: ExpansionContext): string {
  const name = slugify(ctx.parentNode.name)
  const memberHosts = Array.from(
    { length: effectiveReplicas(config) },
    (_, i) => `boz_${ctx.projectSlug}_${name}-${i + 1}`
  )
  const servers = memberHosts
    .map((h, i) => `  server m${i + 1} ${h}:${POSTGRES_PORT} check port ${PATRONI_REST_PORT}`)
    .join("\n")
  return [
    "global",
    "  daemon",
    "  maxconn 256",
    "defaults",
    "  mode tcp",
    "  timeout connect 5s",
    "  timeout client 30s",
    "  timeout server 30s",
    "frontend read",
    "  bind *:5432",
    "  default_backend reader",
    "backend reader",
    // /replica 200 = réplique en streaming. Le leader n'est PAS une cible reader.
    "  option httpchk GET /replica",
    "  http-check expect status 200",
    servers,
    "",
  ].join("\n")
}

/**
 * Membre Patroni (un service Docker par membre — DNS individuel requis).
 * Le démarrage (entrypoint), l'attente postgres et la création de la base
 * applicative vivent dans l'image custom (packages/patroni/entrypoint.sh) — le
 * provider n'a plus de `cmd` (défini à undefined, l'ENTRYPOINT de l'image gère).
 */
function patroniMember(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  host: string,
  name: string,
  replicationSecret: string,
  restapiSecret: string,
): GeneratedResource {
  // `version` du contrat (jamais "latest" - rejeté par Zod) détermine l'image
  // native : on extrait la version MAJEURE pour choisir le tag GHCR
  // `<release>-pg<major>` avec préfixe `v` (ex `v1.2.4-pg16`) — une image par
  // version majeure PG, l'image EST la version. La minor exacte choisie
  // (16.3 vs 16.8) tourne sur la
  // minor buildée au moment du build CI — trade-off assumé (PLAN_PATRONI_CUSTOM).
  const pgMajor = config.version.replace(/^(\d+).*$/, "$1")
  // Préfixe `v` reconstruit : cohérent avec la convention ghcr (les images sont
  // publiées sous leur tag GitHub brut `v1.2.4-pg17`), voir imageRef() de l'updater.
  const patroniTag = `v${HULLBAY_RELEASE}-pg${pgMajor}`
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::member::${index}`,
    name,
    role: "member",
    index,
    config: {
      image: PATRONI_IMAGE.image,
      tag: patroniTag,
      // Pas de cmd : l'ENTRYPOINT de l'image custom (entrypoint.sh) démarre
      // Patroni, attend postgres et crée la base applicative.
      env: {
        PATRONI_SCOPE: slugify(ctx.parentNode.name),
        PATRONI_NAMESPACE: ctx.projectSlug,
        PATRONI_NAME: name,
        PATRONI_RESTAPI_LISTEN: "0.0.0.0:8008",
        PATRONI_RESTAPI_CONNECT_ADDRESS: `${host}:8008`,
        // Basic-auth REST : la VALEUR n'est JAMAIS dans l'env du service. Elle est
        // matérialisée en config-secret généré (catalog-patroni-restapi-<hash8>,
        // via generatedSecrets, monté en fichier /run/secrets/). L'entrypoint de
        // l'image lit ce fichier (via PATRONI_RESTAPI_PASSWORD_FILE) et exporte
        // PATRONI_RESTAPI_PASSWORD dans le conteneur — le seul endroit où elle
        // existe. Ne protège QUE les endpoints "unsafe" (POST /failover, …) —
        // GET /health, /primary, /replica restent sans auth → healthcheck curl +
        // checks HAProxy inchangés.
        PATRONI_RESTAPI_USERNAME: "patroni",
        PATRONI_RESTAPI_PASSWORD_FILE: `/run/secrets/${restapiSecret}`,
        PATRONI_POSTGRESQL_LISTEN: "0.0.0.0:5432",
        PATRONI_POSTGRESQL_CONNECT_ADDRESS: `${host}:5432`,
        PATRONI_POSTGRESQL_DATA_DIR: DATA_MOUNT_PATH,
        PATRONI_SUPERUSER_USERNAME: config.credentials.username,
        PATRONI_SUPERUSER_PASSWORD_FILE: `/run/secrets/${config.credentials.passwordSecretRef!}`,
        PATRONI_REPLICATION_USERNAME: "replicator",
        PATRONI_REPLICATION_PASSWORD_FILE: `/run/secrets/${replicationSecret}`,
        PATRONI_ETCD_HOSTS: etcdClientHosts(config, ctx),
        // Nom de la base applicative à créer par l'entrypoint (le provider seul
        // le connaît ; impossible de l'encoder dans l'image statique).
        PATRONI_DATABASE: config.credentials.database,
      },
      secrets: [
        { secretName: config.credentials.passwordSecretRef! },
        { secretName: replicationSecret },
        { secretName: restapiSecret },
      ],
      resources: config.resources ?? POSTGRES_DEFAULT_RESOURCES,
      healthcheck: patroniHealthcheck(),
      placement: haPlacement(),
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

/** Membre consensus (etcd) — quorum découplé des data-replicas. */
function etcdMember(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  total: number,
): GeneratedResource & { kind: "container" } {
  const name = slugify(ctx.parentNode.name)
  const etcdName = `etcd-${index + 1}`
  const host = `boz_${ctx.projectSlug}_${name}-etcd-${index + 1}`
  const peers = Array.from({ length: total }, (_, i) => {
    const h = `boz_${ctx.projectSlug}_${name}-etcd-${i + 1}`
    return `etcd-${i + 1}=http://${h}:${ETCD_PEER_PORT}`
  }).join(",")
  const clientEndpoints = Array.from({ length: total }, (_, i) =>
    `http://boz_${ctx.projectSlug}_${name}-etcd-${i + 1}:${ETCD_CLIENT_PORT}`
  ).join(",")
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::consensus::${index}`,
    name: `${name}-etcd-${index + 1}`,
    role: "consensus",
    index,
    config: {
      image: ETCD_IMAGE.image,
      tag: ETCD_IMAGE.tag,
      // Wrapper : `existing` si le datadir local a déjà été initialisé OU si le
      // cluster est encore vivant (etcdctl member list contre tous les membres).
      // `new` UNIQUEMENT au bootstrap frais (aucun datadir + cluster impossible) :
      // un `new` sur un cluster vivant refait un bootstrap divergent — les membres
      // existants refusent (cluster-id mismatch) → membre hang, voire deadlock
      // sans quorum si plusieurs datadirs sont perdus.
      cmd: [
        "sh",
        "-c",
        [
          `DATA_DIR="${ETCD_DATA_MOUNT_PATH}"`,
          `CLIENTS="${clientEndpoints}"`,
          'if [ -d "${DATA_DIR}/member" ]; then',
          "  STATE=existing",
          `elif etcdctl --endpoints="\$CLIENTS" member list >/dev/null 2>&1; then`,
          "  STATE=existing",
          "else",
          "  STATE=new",
          "fi",
          "exec etcd \\",
          `  --name=${etcdName} \\`,
          `  --data-dir=${ETCD_DATA_MOUNT_PATH} \\`,
          `  --listen-client-urls=http://0.0.0.0:${ETCD_CLIENT_PORT} \\`,
          `  --advertise-client-urls=http://${host}:${ETCD_CLIENT_PORT} \\`,
          `  --listen-peer-urls=http://0.0.0.0:${ETCD_PEER_PORT} \\`,
          `  --initial-advertise-peer-urls=http://${host}:${ETCD_PEER_PORT} \\`,
          `  --initial-cluster=${peers} \\`,
          `  --initial-cluster-token=${slugify(ctx.parentNode.name)} \\`,
          '  --initial-cluster-state="${STATE}"',
        ].join("\n"),
      ],
      resources: { cpus: 0.25, memMb: 256 },
      healthcheck: etcdHealthcheck(),
      placement: haPlacement(),
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

/** Endpoint HAProxy (writer ou reader) — service unique, porte le config-secret. */
function haproxyEndpoint(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  role: "writer" | "reader",
  generatedSecrets: { name: string; data: string }[],
): GeneratedResource {
  const name = slugify(ctx.parentNode.name)
  const secretName = role === "writer"
    ? `${name}-haproxy-writer-${hash8(haproxyWriterConfig(config, ctx))}`
    : `${name}-haproxy-reader-${hash8(haproxyReaderConfig(config, ctx))}`
  generatedSecrets.push({
    name: secretName,
    data: role === "writer"
      ? haproxyWriterConfig(config, ctx)
      : haproxyReaderConfig(config, ctx),
  })
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::${role}::0`,
    name: `${name}-${role}`,
    role,
    index: 0,
    config: {
      image: HAPROXY_IMAGE.image,
      tag: HAPROXY_IMAGE.tag,
      cmd: ["haproxy", "-f", `/run/secrets/${secretName}`],
      secrets: [{ secretName }],
      resources: { cpus: 0.25, memMb: 128 },
      healthcheck: haproxyHealthcheck(),
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

function etcdClientHosts(config: DatabaseConfig, ctx: ExpansionContext): string {
  const name = slugify(ctx.parentNode.name)
  const total = effectiveConsensus(config) ?? 0
  return Array.from(
    { length: total },
    (_, i) => `boz_${ctx.projectSlug}_${name}-etcd-${i + 1}:${ETCD_CLIENT_PORT}`
  ).join(",")
}

export function expandPostgres(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ExpandedDatabase {
  if (config.engine !== "postgres") {
    throw new DatabaseValidationError([
      `provider postgres : moteur ${config.engine} inattendu`,
    ])
  }
  if (config.mode === "ha") return expandPostgresHa(config, ctx)
  return expandPostgresSingle(config, ctx)
}

function expandPostgresSingle(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ExpandedDatabase {
  const replicas = effectiveReplicas(config)
  if (replicas !== 1) {
    throw new DatabaseValidationError([
      `${config.engine}/${config.mode} : postgres single exige replicas=1`,
    ])
  }

  const name = slugify(ctx.parentNode.name)
  const memberName = name
  const networkName = `${name}-net`
  const volumeName = `${name}-data`

  const memberId = `db::${ctx.parentNodeId}::member::0`
  const networkId = `db::${ctx.parentNodeId}::network::0`
  const volumeId = `db::${ctx.parentNodeId}::volume::0`

  const resources = config.resources ?? POSTGRES_DEFAULT_RESOURCES
  const storage = config.storage

  const member: GeneratedResource = {
    kind: "container",
    nodeId: memberId,
    name: memberName,
    role: "member",
    index: 0,
    config: {
      image: "postgres",
      tag: config.version,
      env: postgresEnv(config),
      secrets: [{ secretName: config.credentials.passwordSecretRef! }],
      resources,
      healthcheck: postgresHealthcheck(config),
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }

  const network: GeneratedResource = {
    kind: "network",
    nodeId: networkId,
    name: networkName,
    role: "network",
    index: 0,
    config: {
      driver: "overlay",
      internal: false,
      attachable: true,
    },
  }

  const volume: GeneratedResource = {
    kind: "volume",
    nodeId: volumeId,
    name: volumeName,
    role: "volume",
    index: 0,
    data: true,
    config: {
      driver: storage.driver,
      driverOpts: storage.driverOpts,
      external: storage.external,
      externalName: storage.externalName,
    },
  }

  return {
    resources: [member, network, volume],
    edges: [
      { source: memberId, target: networkId, kind: "network" },
      { source: memberId, target: volumeId, kind: "volume", config: { mountPath: DATA_MOUNT_PATH } },
    ],
    connections: postgresConnections(config, ctx),
    generatedSecrets: [],
  }
}

/**
 * Expansion HA (replicas data + consensus découplés
 * (validated | config.topology), endpoints writer/reader déterministes.
 */
function expandPostgresHa(
  config: DatabaseConfig,
  ctx: ExpansionContext
): ExpandedDatabase {
  const replicas = effectiveReplicas(config)
  const consensusCount = effectiveConsensus(config) ?? 0

  const name = slugify(ctx.parentNode.name)
  const storage = config.storage
  const networkName = `${name}-net`
  const networkId = `db::${ctx.parentNodeId}::network::0`

  // Secret interne Patroni (réplication) — valeur déterministe, jamais en label/env.
  const generatedSecrets: { name: string; data: string }[] = []
  const replicationValue = derivedInternalSecret(ctx, "patroni-replication")
  const replicationSecret = `${name}-replication-${hash8(replicationValue)}`
  generatedSecrets.push({ name: replicationSecret, data: replicationValue })
  // Secret interne basic-auth REST (POST /failover…) — même politique : config-secret
  // généré monté en fichier, valeur injectée par le cmd-wrapper, jamais en env.
  const restapiValue = derivedInternalSecret(ctx, "patroni-restapi")
  const restapiSecret = `${name}-patroni-restapi-${hash8(restapiValue)}`
  generatedSecrets.push({ name: restapiSecret, data: restapiValue })

  const network: GeneratedResource = {
    kind: "network",
    nodeId: networkId,
    name: networkName,
    role: "network",
    index: 0,
    config: { driver: "overlay", internal: false, attachable: true },
  }

  const resources: GeneratedResource[] = []
  const edges: ExpandedDatabase["edges"] = []

  // Membres Patroni : un service par membre (DNS individuel), volume de données
  // par membre (data=true → rétention destroy), placement spread.
  for (let i = 0; i < replicas; i++) {
    const member = patroniMember(
      config,
      ctx,
      i,
      `boz_${ctx.projectSlug}_${name}-${i + 1}`,
      `${name}-${i + 1}`,
      replicationSecret,
      restapiSecret,
    )
    const volumeId = `db::${ctx.parentNodeId}::volume::${i}`
    resources.push(member)
    resources.push({
      kind: "volume",
      nodeId: volumeId,
      name: `${name}-data-${i + 1}`,
      role: "volume",
      index: i,
      data: true,
      config: {
        driver: storage.driver,
        driverOpts: storage.driverOpts,
        external: storage.external,
        externalName: storage.externalName,
      },
    })
    edges.push({ source: member.nodeId, target: networkId, kind: "network" })
    edges.push({
      source: member.nodeId,
      target: volumeId,
      kind: "volume",
      config: { mountPath: DATA_MOUNT_PATH },
    })
  }

  // Consensus etcd (découplé des data-replicas). Volumes de coordination
  // data:false → supprimables au destroy (pas de données utilisateur).
  for (let i = 0; i < consensusCount; i++) {
    const etcd = etcdMember(config, ctx, i, consensusCount)
    const volId = `db::${ctx.parentNodeId}::consensus-volume::${i}`
    resources.push(etcd)
    resources.push({
      kind: "volume",
      nodeId: volId,
      name: `${name}-etcd-data-${i + 1}`,
      role: "volume",
      index: i,
      data: false,
      config: {
        driver: storage.driver,
        driverOpts: storage.driverOpts,
        external: false,
      },
    })
    edges.push({ source: etcd.nodeId, target: networkId, kind: "network" })
    edges.push({
      source: etcd.nodeId,
      target: volId,
      kind: "volume",
      config: { mountPath: ETCD_DATA_MOUNT_PATH },
    })
  }

  // Endpoints writer/reader (HAProxy) + réseau commun.
  const writer = haproxyEndpoint(config, ctx, "writer", generatedSecrets)
  const reader = haproxyEndpoint(config, ctx, "reader", generatedSecrets)
  resources.push(writer, reader, network)
  edges.push({ source: writer.nodeId, target: networkId, kind: "network" })
  edges.push({ source: reader.nodeId, target: networkId, kind: "network" })

  return {
    resources,
    edges,
    connections: postgresConnections(config, ctx),
    generatedSecrets,
  }
}

export const postgresProvider: DatabaseProvider = {
  engine: "postgres",
  validate(config: DatabaseConfig): void {
    if (config.engine !== "postgres") {
      throw new DatabaseValidationError([`provider postgres : moteur ${config.engine} inattendu`])
    }
    validateDatabaseConfig(config)
    if (!config.credentials.passwordSecretRef) {
      throw new DatabaseValidationError([
        "passwordSecretRef requis : sélectionne le secret Docker du mot de passe (module Secrets).",
      ])
    }
    // external + HA : tous les membres reçoivent le MÊME externalName monté sur
    // PGDATA → deux Postgres se partagent un même disque : corruption garantie.
    // Correctif : volumes managés par membre (défaut) ou mode single.
    if (config.mode === "ha" && config.storage.external) {
      throw new DatabaseValidationError([
        "postgres/ha : volume externe non supporté en HA — le même externalName serait monté par tous les membres sur PGDATA (corruption). Utilise les volumes managés par membre.",
      ])
    }
  },
  expand: expandPostgres,
  connection: postgresConnections,
}