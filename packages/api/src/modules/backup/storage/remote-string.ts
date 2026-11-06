import type { BackupDestinationFields, BackupProtocol } from "@hullbay/shared"
import { obscureSecret } from "./obscure"

/**
 * Construction de la remote-string Rclone — SEUL endroit du dépôt où les
 * credentials de destination sont assemblés.
 *
 * Règles :
 *  - la chaîne est construite en mémoire, jamais écrite sur disque ;
 *  - elle ne doit jamais être loggée ni renvoyée : `redactRemoteString` est le
 *    seul format autorisé en sortie (erreurs, traces, réponses) ;
 *  - l'échappement neutralise `\`, `,` et `:` pour qu'une valeur ne puisse pas
 *    injecter un paramètre supplémentaire.
 */

/** Échappe une valeur de paramètre de connection-string rclone. */
export function escapeRemoteParam(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/:/g, "\\:")
}

/**
 * Extrait d'une URL WebDAV d'éventuelles credentials embarquées
 * (`https://user:pass@host`). Elles sont renvoyées séparément pour être
 * obscurcies (jamais laissées en clair dans la remote-string ni dans les logs).
 * Renvoie l'URL nettoyée + user/pass extraits (décodés) le cas échéant.
 */
export function stripUrlCredentials(rawUrl: string): {
  url: string
  username?: string
  password?: string
} {
  const m = rawUrl.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^@/\s]+)@/)
  if (!m || !m[0] || !m[1] || !m[2]) return { url: rawUrl }
  const full = m[0]
  const scheme = m[1]
  const auth = m[2]
  const colon = auth.indexOf(":")
  if (colon === -1) return { url: rawUrl } // user seul, sans mot de passe : on laisse tel quel
  const username = decodeURIComponent(auth.slice(0, colon))
  const password = decodeURIComponent(auth.slice(colon + 1))
  return {
    url: rawUrl.slice(0, scheme.length) + rawUrl.slice(full.length),
    username,
    password,
  }
}

export interface RemoteStringInput {
  protocol: BackupProtocol
  config: BackupDestinationFields
  basePath: string
  /**
   * Chemins (tmpfs du task) des secrets matérialisés en fichier — une clé SSH
   * ou un JSON de service account ne peuvent pas voyager dans la chaîne.
   */
  secretFiles?: { privateKey?: string; serviceAccountJson?: string }
}

function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0)
    .join("/")
}

/** Chemin distant (conteneur/bucket + basePath), sans slash superflu. */
export function buildRemotePath(
  protocol: BackupProtocol,
  config: BackupDestinationFields,
  basePath: string,
): string {
  switch (config.protocol) {
    case "s3":
    case "gcs":
      return joinPath(config.bucket, basePath)
    case "azureblob":
      return joinPath(config.container, basePath)
    case "smb":
      return joinPath(config.share, basePath)
    case "sftp":
      // Chemin depuis la racine SFTP (chroot du compte) : le basePath ne porte
      // pas de `/` initial par contrat, rclone le résout depuis cette racine.
      return joinPath(basePath)
    case "webdav":
      return joinPath(basePath)
  }
}

function paramsFor(input: RemoteStringInput): [string, string][] {
  const { config, secretFiles } = input
  switch (config.protocol) {
    case "s3": {
      const params: [string, string][] = [
        ["access_key_id", config.accessKeyId],
        ["secret_access_key", obscureSecret(config.secretAccessKey)],
      ]
      if (config.region) params.push(["region", config.region])
      if (config.endpoint) {
        params.push(["endpoint", config.endpoint], ["provider", "Other"])
      }
      if (config.pathStyle) params.push(["force_path_style", "true"])
      return params
    }
    case "sftp": {
      const params: [string, string][] = [
        ["host", config.host],
        ["user", config.username],
        ["port", String(config.port)],
      ]
      if (config.password) params.push(["pass", obscureSecret(config.password)])
      if (secretFiles?.privateKey) params.push(["key_file", secretFiles.privateKey])
      if (config.hostKeyFingerprint) {
        params.push(["host_key", config.hostKeyFingerprint])
      }
      return params
    }
    case "webdav": {
      // Credentials embarqués dans l'URL (user:pass@) → extraits et obscurcis,
      // l'URL finale ne contient plus aucun secret.
      const stripped = stripUrlCredentials(config.url)
      const username = stripped.username ?? config.username
      const password = stripped.password ?? config.password
      const params: [string, string][] = [
        ["url", stripped.url],
        ["vendor", "other"],
      ]
      if (username) params.push(["user", username])
      if (password) params.push(["pass", obscureSecret(password)])
      return params
    }
    case "smb": {
      const params: [string, string][] = [
        ["host", config.host],
        ["user", config.username],
        ["pass", obscureSecret(config.password)],
      ]
      if (config.domain) params.push(["domain", config.domain])
      return params
    }
    case "gcs": {
      // Le JSON ne peut pas voyager dans la chaîne : fichier tmpfs obligatoire.
      const params: [string, string][] = []
      if (secretFiles?.serviceAccountJson) {
        params.push([
          "service_account_credentials",
          secretFiles.serviceAccountJson,
        ])
      }
      return params
    }
    case "azureblob":
      return [
        ["account", config.accountName],
        ["key", obscureSecret(config.accountKey)],
      ]
  }
}

/**
 * `:protocol,param=value,...:container/basePath`
 * Le résultat contient des credentials — ne jamais le persister ni le logguer.
 */
export function buildRcloneRemoteString(input: RemoteStringInput): string {
  if (input.protocol !== input.config.protocol) {
    throw new Error(`protocole incohérent : ${input.protocol} / ${input.config.protocol}`)
  }
  const params = paramsFor(input)
    .map(([k, v]) => `${k}=${escapeRemoteParam(v)}`)
    .join(",")
  const path = buildRemotePath(input.protocol, input.config, input.basePath)
  return `:${input.protocol}${params ? `,${params}` : ""}:${path}`
}

const SECRET_PARAM = /(pass|key|secret|credential|token|account)/i

/** Découpe une remote-string en respectant les échappements (les valeurs
 *  peuvent contenir `,` et `:` échappés). */
function splitRemote(
  remote: string,
): { protocol: string; params: string; path: string } | null {
  if (!remote.startsWith(":")) return null
  let i = 1
  while (i < remote.length && /[a-z0-9]/i.test(remote.charAt(i))) i += 1
  const protocol = remote.slice(1, i)
  if (!protocol) return null
  if (remote[i] === ":") return { protocol, params: "", path: remote.slice(i + 1) }
  if (remote[i] !== ",") return null
  i += 1
  const start = i
  let escaped = false
  while (i < remote.length) {
    const ch = remote.charAt(i)
    if (escaped) {
      escaped = false
      i += 1
      continue
    }
    if (ch === "\\") {
      escaped = true
      i += 1
      continue
    }
    if (ch === ":") break
    i += 1
  }
  if (remote[i] !== ":") return null
  return { protocol, params: remote.slice(start, i), path: remote.slice(i + 1) }
}

function splitParams(params: string): string[] {
  const out: string[] = []
  let current = ""
  let escaped = false
  for (const ch of params) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === "\\") {
      current += ch
      escaped = true
      continue
    }
    if (ch === ",") {
      out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * Version sûre pour logs/erreurs/réponses : les valeurs sensibles sont
 * masquées, le reste (protocole, hôte, chemin) reste lisible pour diagnostiquer.
 */
export function redactRemoteString(remote: string): string {
  const parsed = splitRemote(remote)
  if (!parsed) return "[remote masquée]"
  const params = splitParams(parsed.params)
    .map((pair) => {
      const eq = pair.indexOf("=")
      if (eq === -1) return pair
      const key = pair.slice(0, eq)
      return SECRET_PARAM.test(key) ? `${key}=***` : pair
    })
    .join(",")
  return params.length > 0
    ? `:${parsed.protocol},${params}:${parsed.path}`
    : `:${parsed.protocol}:${parsed.path}`
}

/**
 * Filtre défensif appliqué à toute erreur avant persistance : une sortie rclone
 * peut citer la remote-string complète. On ne laisse jamais passer un motif
 * `protocole,param=valeur` ni un champ de type mot de passe.
 */
export function scrubSecrets(text: string): string {
  return text
    // Remote-string complète : `:proto,param=value,...:chemin`. L'exigence d'au
    // moins un `,param=` évite de confondre une heure (`10:30:45`) avec un remote.
    .replace(
      /:[a-z][a-z0-9]{1,20}(?:,[a-z_]+=[^\s,"']*)+:[^\s"']*/gi,
      "[remote masquée]",
    )
    .replace(/(pass|password|secret|key|token)\s*[=:]\s*\S+/gi, "$1=***")
}
