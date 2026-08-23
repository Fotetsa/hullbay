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
 * Provider MySQL — slice verticale .
 *
 * ── SINGLE : `mysql:<version>` + volume data + réseau + healthcheck mysqladmin.
 *
 * ── HA  : Group Replication single-primary + ProxySQL (routing).
 *    MEMBRES : un service Docker par membre (replicas=1, DNS individuel
 *    boz_<slug>_<db>-<i>), args GR communs + `--server-id` ; le membre 0 porte
 *    `--group-replication-bootstrap-group=ON` (bootstrap du groupe), les autres
 *    démarrent en récupération (--group-replication-start-on-boot=ON).
 *    ENDPOINTS : deux ProxySQL (writer 6033 / reader 6034) dont default_hostgroup
 *    pointe vers 10 (écriture) ou 20 (lecture) ; la classification
 *    PRIMARY/SECONDARY est faite par ProxySQL (table mysql_group_replication_
 *    hostgroups) — PAS un healthcheck maison.
 *
 * ── SÉCURITÉ : aucune valeur sensible dans labels/env/cmd. Les secrets
 *    INTERNES (root MySQL, réplicator GR, monitor/admin ProxySQL) sont des
 *    config-secrets versionnés `-<hash8>` (mechanisme secretsStep). Le mot de
 *    passe APPLICATIF (passwordSecretRef) n'apparaît jamais dans la config
 *    générée : monté en fichier dans le conteneur, lu au runtime par le wrapper
 *    ProxySQL puis injecté dans le cnf final (ProxySQL authentifie lui-même).
 *
 * NOTE DE VALIDATION : le premier démarrage multi-membres GR (ordre seed /
 *   joigneurs) et l'exactitude des images sont à valider au lab live — l'expansion,
 *   les secrets et le schéma restent purs, déterministes et testés.
 */

const MYSQL_PORT = 3306
const PROXY_WRITER_PORT = 6033
const PROXY_READER_PORT = 6034
const PROXYSQL_ADMIN_PORT = 6032
const DATA_MOUNT_PATH = "/var/lib/mysql"
const PROXYSQL_DATA_MOUNT_PATH = "/var/lib/proxysql"

const MYSQL_DEFAULT_RESOURCES = { cpus: 0.5, memMb: 512 }
const PROXYSQL_DEFAULT_RESOURCES = { cpus: 0.25, memMb: 256 }
const PROXYSQL_IMAGE = { image: "proxysql/proxysql", tag: "2.7.0" }

/** Comptes INTERNES créés par l'init SQL généré (jamais en env/label/cmd). */
const GR_REPL_USER = "mysql_repl"
const GR_MONITOR_USER = "mysql_monitor"
const PROXYSQL_ADMIN_USER = "admin"

/** Champs sectionnés de derivedInternalSecret (stabilité des chemins de dériv.). */
const FIELD_MYSQL_ROOT = "mysql-root"
const FIELD_GR_REPLICATION = "mysql-gr-replication"
const FIELD_MONITOR = "proxysql-monitor"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

/** Valeur interne déterministe (spec §19, pureté de l'expansion). */
function derivedInternalSecret(ctx: ExpansionContext, field: string): string {
  return createHash("sha256").update(`${ctx.parentNodeId}:${field}`).digest("hex").slice(0, 24)
}

/** UUID de groupe GR déterministe (format UUID v4-like, bits version/variant). */
function groupReplicationUuid(ctx: ExpansionContext): string {
  const hex = createHash("sha256")
    .update(`${ctx.parentNodeId}:group-replication`)
    .digest("hex")
  const top = parseInt(hex.slice(12, 16), 16) & 0x0fff | 0x4000
  const variant = parseInt(hex.slice(16, 18), 16) & 0x3f | 0x80
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${top.toString(16).padStart(4, "0")}-` +
    `${variant.toString(16).padStart(2, "0")}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
  )
}

/** Env client MySQL d'un membre (mot de passe monté en fichier, jamais en env). */
function mysqlEnv(config: DatabaseConfig, rootSecretName: string): Record<string, string> {
  return {
    MYSQL_USER: config.credentials.username,
    MYSQL_PASSWORD_FILE: `/run/secrets/${config.credentials.passwordSecretRef!}`,
    MYSQL_DATABASE: config.credentials.database,
    MYSQL_ROOT_PASSWORD_FILE: `/run/secrets/${rootSecretName}`,
    // root ne doit être joignable QUE localement (socket) — le GROUP REPLICATION
    // et ProxySQL utilisent leurs comptes dédiés (mysql_repl/mysql_monitor).
    MYSQL_ROOT_HOST: "127.0.0.1",
  }
}

/**
 * Args GR communs ; `index` gère server-id. Le bootstrap du seed (membre 0) est
 * géré par le wrapper (marqueur datadir, pas un flag CLI figé). local-address +
 * group-seeds explicites : sans eux, GCS écoute sur 127.0.0.1:33061 (loopback)
 * et les joineurs n'ont AUCUNE cible de seed → le groupe ne se forme jamais.
 */
function groupReplicationArgs(ctx: ExpansionContext, index: number, host: string): string[] {
  const name = slugify(ctx.parentNode.name)
  const seedHosts = Array.from(
    { length: effectiveReplicas(ctx.parentNode.config) },
    (_, i) => `boz_${ctx.projectSlug}_${name}-${i + 1}:33061`
  ).join(",")
  return [
    `--server-id=${index + 1}`,
    "--log-bin=mysql-bin",
    "--binlog-format=ROW",
    "--gtid-mode=ON",
    "--enforce-gtid-consistency=ON",
    `--group-replication-group-name=${groupReplicationUuid(ctx)}`,
    // §14 : canal GCS de ce membre + seeds pour la découverte du groupe.
    `--group-replication-local-address=${host}:33061`,
    `--group-replication-group-seeds=${seedHosts}`,
    // Premier join via caching_sha2_password sans SSL : échange clef RSA requis.
    "--group-replication-recovery-get-public-key=ON",
    "--group-replication-start-on-boot=ON",
    "--group-replication-single-primary-mode=ON",
    "--group-replication-autorejoin-tries=5",
  ]
}

/**
 * Wrapper d'entrée d'un membre HA : copie le SQL d'init GR du secret vers
 * /docker-entrypoint-initdb.d/ AVANT l'entrypoint (l'entrypoint officiel ne
 * lit que cette arborescence — un secret monté dans /run/secrets n'y suffit
 * PAS : sans cette copie, `mysql_repl`/`mysql_monitor` et les PERSIST de
 * récupération ne sont jamais créés → les joineurs restent RECOVERING).
 *
 * Le membre 0 ne bootstrap le groupe que si le datadir est vierge (marqueur
 * `/var/lib/mysql/mysql` existant) — pas à chaque restart, sinon split-brain
 * (flag PI permanent + restart = nouveau groupe divergent).
 */
function memberCmd(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  initSecretName: string,
  host: string
): string[] {
  const args = groupReplicationArgs(ctx, index, host)
  const bootstrapArg = "--group-replication-bootstrap-group=ON"
  const lines = [
    "set -e",
    `cp /run/secrets/${initSecretName} /docker-entrypoint-initdb.d/00-gr-init.sql`,
  ]
  if (index === 0) {
    lines.push(
      `if [ -d /var/lib/mysql/mysql ]; then exec docker-entrypoint.sh mysqld ${args.join(" ")}; fi`,
      `exec docker-entrypoint.sh mysqld ${bootstrapArg} ${args.join(" ")}`
    )
  } else {
    lines.push(`exec docker-entrypoint.sh mysqld ${args.join(" ")}`)
  }
  return ["/bin/sh", "-c", lines.join("\n")]
}

/**
 * Init SQL d'un membre (config-secret monté dans /docker-entrypoint-initdb.d/,
 * joué UNE fois au premier init du datadir). Crée les comptes internes GR
 * (replicateur + monitor, mots de passe dérivés → config-secret §23) et PERSISTE
 * les credentials de récupération (SET PERSIST → survivent au restart). Le seed
 * ne bootstrap PAS ici : impossible en phase init (serveur temporaire sous
 * --skip-networking) — le bootstrap réel se fait au 1er démarrage du serveur
 * final via le flag CLI du membre 0.
 */
function groupReplicationInitSql(
  config: DatabaseConfig,
  ctx: ExpansionContext
): string {
  const replV = derivedInternalSecret(ctx, FIELD_GR_REPLICATION)
  const monV = derivedInternalSecret(ctx, FIELD_MONITOR)
  return [
    "-- généré par le provider mysql (déterministe, spec §14/§23).",
    `CREATE USER IF NOT EXISTS '${GR_REPL_USER}'@'%' IDENTIFIED WITH caching_sha2_password BY '${replV}';`,
    `GRANT REPLICATION SLAVE, REPLICATION CLIENT, GROUP_REPLICATION_STREAM ON *.* TO '${GR_REPL_USER}'@'%';`,
    `CREATE USER IF NOT EXISTS '${GR_MONITOR_USER}'@'%' IDENTIFIED WITH caching_sha2_password BY '${monV}';`,
    `GRANT REPLICATION CLIENT, REPLICATION SLAVE, SELECT ON *.* TO '${GR_MONITOR_USER}'@'%';`,
    `SET PERSIST group_replication_recovery_user='${GR_REPL_USER}';`,
    `SET PERSIST group_replication_recovery_password='${replV}';`,
    "",
  ].join("\n")
}

/** cnf ProxySQL (template) d'un endpoint writer/reader — placeholders applicatifs. */
function proxysqlCnfTemplate(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  role: "writer" | "reader"
): string {
  const name = slugify(ctx.parentNode.name)
  const memberHosts = Array.from(
    { length: effectiveReplicas(config) },
    (_, i) => `boz_${ctx.projectSlug}_${name}-${i + 1}`
  )
  const servers = memberHosts
    .map(
      (h) =>
        `        host="${h}"\n        port=${MYSQL_PORT}\n        hostgroup=10\n        weight=1`
    )
    .join("\n")
  const monitorPw = derivedInternalSecret(ctx, FIELD_MONITOR)
  const adminPw = derivedInternalSecret(ctx, `proxysql-admin-${role}`)
  const defaultHg = role === "writer" ? "10" : "20"
  return `datadir="${PROXYSQL_DATA_MOUNT_PATH}"
admin_variables:
    admin_credentials="${PROXYSQL_ADMIN_USER}:${adminPw}"
    mysql_ifaces="127.0.0.1:${PROXYSQL_ADMIN_PORT}"
mysql_variables:
    threads=4
    max_connections=2048
    default_query_delay=0
    default_query_timeout=36000000
    monitor_username="${GR_MONITOR_USER}"
    monitor_password="${monitorPw}"
    monitor_history=600000
    monitor_connect_interval=2000
    monitor_ping_interval=2000
    monitor_read_only_interval=1500
    monitor_replication_lag_interval=10000
mysql_servers:
${servers}
mysql_group_replication_hostgroups:
    writer_hostgroup=10
    backend_writer_count=1
    reader_hostgroup=20
    offline_hostgroup=99
    active=1
mysql_users:
        username = "__APP_USER__"
        password = "__APP_PW__"
        default_hostgroup = ${defaultHg}
        max_connections=500
`
}

/**
 * Wrapper d'entrée ProxySQL : matérialise le cnf final (remplace les placeholders
 * par les secrets référencés LUS DES FICHIERS montés) puis `proxysql --initial`.
 * Fils `|` échappés en bash (séparateur de sed) ; username limité par validate.
 */
function proxysqlWrapperCmd(
  ctx: ExpansionContext,
  templateSecretName: string,
  appPasswordSecretRef: string
): string[] {
  return [
    "/bin/sh",
    "-c",
    [
      "set -e",
      'APP_USER="${MYSQL_APP_USER}"',
      `APP_PW="$(cat /run/secrets/${appPasswordSecretRef})"`,
      // Échappe LES caractères spéciaux sed (séparateur, backreference, newline).
      // L'ordre compte : d'abord le backslash, puis & et | (et fin de ligne).
      'APP_USER_ESC="$(printf "%s" "$APP_USER" | sed \'s/[&\\\\/]/\\\\&/g; s/\\n/\\\\n/g\')"',
      'APP_PW_ESC="$(printf "%s" "$APP_PW" | sed \'s/[&\\\\/]/\\\\&/g; s/\\n/\\\\n/g\')"',
      `sed "s|__APP_USER__|$APP_USER_ESC|g; s|__APP_PW__|$APP_PW_ESC|g" /run/secrets/${templateSecretName} > /tmp/proxysql.cnf`,
      "exec proxysql --initial -f /tmp/proxysql.cnf",
    ].join("\n"),
  ]
}

/** Healthcheck d'un membre MySQL : server vivant, mot de passe lu au runtime.
 *  MYSQL_PWD (env) plutôt que `-p` argv : le secret ne transite pas en argument
 *  de process (visible dans `ps` sur le nœud). */
function memberHealthcheck(config: DatabaseConfig) {
  return {
    test: [
      "CMD-SHELL",
      `MYSQL_PWD="$(cat /run/secrets/${config.credentials.passwordSecretRef!})" ` +
        `mysqladmin ping -h 127.0.0.1 -u"${config.credentials.username}" --silent`,
    ],
    intervalSec: 10,
    timeoutSec: 5,
    retries: 5,
    startPeriodSec: 20,
  }
}

/** Endpoint ProxySQL (writer ou reader). */
function proxysqlEndpoint(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  role: "writer" | "reader",
  port: number,
  appPasswordSecretRef: string,
  generatedSecrets: { name: string; data: string }[]
): GeneratedResource & { kind: "container" } {
  const name = slugify(ctx.parentNode.name)
  const templateData = proxysqlCnfTemplate(config, ctx, role)
  const templateName = `${name}-proxysql-${role}-${hash8(templateData)}`
  const adminValue = derivedInternalSecret(ctx, `proxysql-admin-${role}`)
  const adminName = `${name}-proxysql-${role}-admin-${hash8(adminValue)}`
  generatedSecrets.push({ name: templateName, data: templateData })
  generatedSecrets.push({ name: adminName, data: adminValue })
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::proxy-${role}::0`,
    name: `${name}-${role}`,
    role,
    index: 0,
    config: {
      image: PROXYSQL_IMAGE.image,
      tag: PROXYSQL_IMAGE.tag,
      env: { MYSQL_APP_USER: config.credentials.username },
      secrets: [
        { secretName: templateName },
        { secretName: adminName },
        { secretName: appPasswordSecretRef },
      ],
      cmd: proxysqlWrapperCmd(ctx, templateName, appPasswordSecretRef),
      resources: PROXYSQL_DEFAULT_RESOURCES,
      healthcheck: {
        test: [
          "CMD-SHELL",
          `MYSQL_PWD="$(cat /run/secrets/${adminName})" ` +
            `mysqladmin ping -h 127.0.0.1 -P${PROXYSQL_ADMIN_PORT} -u${PROXYSQL_ADMIN_USER} --silent`,
        ],
        intervalSec: 10,
        timeoutSec: 5,
        retries: 5,
        startPeriodSec: 20,
      },
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

// ── Connexions (descriptor générique → env DATABASE_*) ────────────

export function mysqlConnections(
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
        port: MYSQL_PORT,
        database,
        username,
        passwordSecretRef,
        env: {
          DATABASE_HOST: host,
          DATABASE_PORT: String(MYSQL_PORT),
          DATABASE_USER: username,
          DATABASE_NAME: database,
          DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
          DATABASE_SCHEME: "mysql",
        },
      },
    ]
  }

  const base = slugify(ctx.parentNode.name)
  const writerHost = `boz_${ctx.projectSlug}_${base}-writer`
  const readerHost = `boz_${ctx.projectSlug}_${base}-reader`
  return [
    {
      role: "writer",
      host: writerHost,
      port: PROXY_WRITER_PORT,
      database,
      username,
      passwordSecretRef,
      env: {
        DATABASE_HOST: writerHost,
        DATABASE_PORT: String(PROXY_WRITER_PORT),
        DATABASE_USER: username,
        DATABASE_NAME: database,
        DATABASE_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
        DATABASE_SCHEME: "mysql",
      },
    },
    {
      role: "reader",
      host: readerHost,
      port: PROXY_READER_PORT,
      database,
      username,
      passwordSecretRef,
      env: {
        DATABASE_READ_HOST: readerHost,
        DATABASE_READ_PORT: String(PROXY_READER_PORT),
        DATABASE_READ_CREDENTIALS_FILE: `/run/secrets/${passwordSecretRef}`,
        DATABASE_READ_SCHEME: "mysql",
      },
    },
  ]
}

// ── Expansions ────────────────────────────────────────────────────────────────

function memberContainer(
  config: DatabaseConfig,
  ctx: ExpansionContext,
  index: number,
  rootSecretName: string,
  initSecretName: string
): GeneratedResource & { kind: "container" } {
  const name = slugify(ctx.parentNode.name)
  const host = `boz_${ctx.projectSlug}_${name}-${index + 1}`
  return {
    kind: "container",
    nodeId: `db::${ctx.parentNodeId}::member::${index}`,
    name: `${name}-${index + 1}`,
    role: "member",
    index,
    config: {
      image: "mysql",
      tag: config.version,
      env: mysqlEnv(config, rootSecretName),
      secrets: [
        { secretName: config.credentials.passwordSecretRef! },
        { secretName: rootSecretName },
        { secretName: initSecretName },
      ],
      cmd: memberCmd(config, ctx, index, initSecretName, host),
      resources: config.resources ?? MYSQL_DEFAULT_RESOURCES,
      healthcheck: memberHealthcheck(config),
      placement: { constraints: [], spreadOver: ["node.id"] },
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
}

function expandMySqlSingle(
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

  const rootValue = derivedInternalSecret(ctx, FIELD_MYSQL_ROOT)
  const rootSecretName = `${name}-mysql-root-${hash8(rootValue)}`

  const member: GeneratedResource = {
    kind: "container",
    nodeId: memberId,
    name,
    role: "member",
    index: 0,
    config: {
      image: "mysql",
      tag: config.version,
      env: mysqlEnv(config, rootSecretName),
      secrets: [
        { secretName: config.credentials.passwordSecretRef! },
        { secretName: rootSecretName },
      ],
      resources: config.resources ?? MYSQL_DEFAULT_RESOURCES,
      healthcheck: memberHealthcheck(config),
      replicas: 1,
      updateParallelism: 1,
      updateDelaySec: 5,
    },
  }
  const network: GeneratedResource = {
    kind: "network",
    nodeId: networkId,
    name: `${name}-net`,
    role: "network",
    index: 0,
    config: { driver: "overlay", internal: false, attachable: true },
  }
  const volume: GeneratedResource = {
    kind: "volume",
    nodeId: volumeId,
    name: `${name}-data`,
    role: "volume",
    index: 0,
    data: true,
    config: {
      driver: config.storage.driver,
      driverOpts: config.storage.driverOpts,
      external: config.storage.external,
      externalName: config.storage.externalName,
    },
  }

  return {
    resources: [member, network, volume],
    edges: [
      { source: memberId, target: networkId, kind: "network" },
      { source: memberId, target: volumeId, kind: "volume", config: { mountPath: DATA_MOUNT_PATH } },
    ],
    connections: mysqlConnections(config, ctx),
    generatedSecrets: [{ name: rootSecretName, data: rootValue }],
  }
}

/**
 * Expansion HA: membres Group Replication (replicas data) + deux
 * ProxySQL (writer/reader). PAS de consensus découplé (§13 : mysql consensus=null
 * — la majorité est interne aux membres).
 */
function expandMySqlHa(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  const replicas = effectiveReplicas(config)

  const name = slugify(ctx.parentNode.name)
  const networkId = `db::${ctx.parentNodeId}::network::0`
  const generatedSecrets: { name: string; data: string }[] = []

  const rootValue = derivedInternalSecret(ctx, FIELD_MYSQL_ROOT)
  const rootSecretName = `${name}-mysql-root-${hash8(rootValue)}`
  generatedSecrets.push({ name: rootSecretName, data: rootValue })

  const network: GeneratedResource = {
    kind: "network",
    nodeId: networkId,
    name: `${name}-net`,
    role: "network",
    index: 0,
    config: { driver: "overlay", internal: false, attachable: true },
  }

  const resources: GeneratedResource[] = []
  const edges: ExpandedDatabase["edges"] = []

  // Membres GR : un service par membre (DNS individuel), volume data par membre.
  for (let i = 0; i < replicas; i++) {
    const initSql = groupReplicationInitSql(config, ctx)
    const initSecretName = `${name}-gr-init-${i + 1}-${hash8(initSql)}`
    generatedSecrets.push({ name: initSecretName, data: initSql })
    const member = memberContainer(config, ctx, i, rootSecretName, initSecretName)
    const volumeId = `db::${ctx.parentNodeId}::volume::${i}`
    resources.push(member)
    resources.push({
      kind: "volume",
      nodeId: volumeId,
      name: `${name}-data-${i + 1}`,
      role: "volume",
      index: i,
      data: true,
      config: { driver: "local", external: false },
    })
    edges.push({ source: member.nodeId, target: networkId, kind: "network" })
    edges.push({
      source: member.nodeId,
      target: volumeId,
      kind: "volume",
      config: { mountPath: DATA_MOUNT_PATH },
    })
  }

  // Endpoints ProxySQL (writer/reader) + leurs volumes de données (data:false).
  const writer = proxysqlEndpoint(
    config, ctx, "writer", PROXY_WRITER_PORT, config.credentials.passwordSecretRef!, generatedSecrets
  )
  const reader = proxysqlEndpoint(
    config, ctx, "reader", PROXY_READER_PORT, config.credentials.passwordSecretRef!, generatedSecrets
  )
  const writerVolId = `db::${ctx.parentNodeId}::proxy-volume-writer::0`
  const readerVolId = `db::${ctx.parentNodeId}::proxy-volume-reader::0`
  resources.push(writer, reader, network)
  resources.push(
    {
      kind: "volume",
      nodeId: writerVolId,
      name: `${name}-proxysql-writer-data`,
      role: "volume",
      index: 0,
      data: false,
      config: { driver: "local", external: false },
    },
    {
      kind: "volume",
      nodeId: readerVolId,
      name: `${name}-proxysql-reader-data`,
      role: "volume",
      index: 0,
      data: false,
      config: { driver: "local", external: false },
    }
  )
  edges.push(
    { source: writer.nodeId, target: networkId, kind: "network" },
    { source: reader.nodeId, target: networkId, kind: "network" },
    {
      source: writer.nodeId,
      target: writerVolId,
      kind: "volume",
      config: { mountPath: PROXYSQL_DATA_MOUNT_PATH },
    },
    {
      source: reader.nodeId,
      target: readerVolId,
      kind: "volume",
      config: { mountPath: PROXYSQL_DATA_MOUNT_PATH },
    }
  )

  return {
    resources,
    edges,
    connections: mysqlConnections(config, ctx),
    generatedSecrets,
  }
}

/** Dispatch single/HA (interface DatabaseProvider.expand). */
export function expandMySql(config: DatabaseConfig, ctx: ExpansionContext): ExpandedDatabase {
  return config.mode === "ha" ? expandMySqlHa(config, ctx) : expandMySqlSingle(config, ctx)
}

export const mysqlProvider: DatabaseProvider = {
  engine: "mysql",
  validate(config: DatabaseConfig): void {
    if (config.engine !== "mysql") {
      throw new DatabaseValidationError([`provider mysql : moteur ${config.engine} inattendu`])
    }
    validateDatabaseConfig(config)
    if (!config.credentials.passwordSecretRef) {
      throw new DatabaseValidationError([
        "passwordSecretRef requis : sélectionne le secret Docker du mot de passe (module Secrets).",
      ])
    }
    if (config.mode === "ha" && config.storage.external) {
      throw new DatabaseValidationError([
        "mysql/ha : volume externe non supporté en HA — l'externalName serait monté par tous les membres sur /var/lib/mysql (corruption). Utilise les volumes managés par membre.",
      ])
    }
    // Interpolé dans le wrapper ProxySQL : jeu restreint pour exclure l'injection.
    if (!/^[A-Za-z0-9_-]+$/.test(config.credentials.username)) {
      throw new DatabaseValidationError([
        "mysql : username limité à [A-Za-z0-9_-] (interpolé dans la config ProxySQL)",
      ])
    }
  },
  expand: expandMySql,
  connection: mysqlConnections,
}