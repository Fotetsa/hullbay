/**
 * SecretEncryptionService : chiffrement/déchiffrement AES-256-GCM séparé par
 * domaine (MFA / PROVIDER / SESSION) — clé indépendante par scope pour permettre
 * une rotation indépendante.
 *
 * Rotation : re-chiffrement progressif PAR ENREGISTREMENT, sans
 * down-time ni big-bang. Le payload chiffré porte une empreinte de clé
 * (fingerprint) `k<hex>:iv:tag:data` pour :
 *   - détecter les enregistrements déjà tournés (idempotence du script) ;
 *   - déchiffrer les anciens payloads pendant la fenêtre de bascule
 *     (`{ENV}_PREVIOUS`), i.e. compat ascendante pendant la transition.
 * Les payloads LEGACY (sans préfixe `k…:`) restent déchiffrables (décrypt
 * tente current → previous), la bascule ne casse jamais la lecture.
 *
 * Les appels existants (auth/service, registry/service, lib/keys, lib/ssh-tunnel,
 * workflows) passent par la façade compat encryptSecret/decryptSecret → scope "mfa".
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"

export type SecretKind = "mfa" | "provider" | "session" | "backup"

const SECRET_CONFIG: Record<SecretKind, { envKey: string; label: string }> = {
  mfa:      { envKey: "MFA_ENCRYPTION_KEY",      label: "MFA" },
  provider: { envKey: "PROVIDER_SECRET_KEY",      label: "PROVIDER" },
  session:  { envKey: "SESSION_SIGNING_KEY",       label: "SESSION" },
  backup:   { envKey: "BACKUP_ENCRYPTION_KEY",     label: "BACKUP" },
}

/** Empreinte (16 hex soit 8 octets) d'une clé — rend les rotations détectables.
 *  Préfixée `k…:` sur les payloads chiffrés par `encrypt`.
 *  Sans clé fournie, utilise la clé courante du scope (celle qui décrypte). */
export function keyFingerprint(kind: SecretKind, keyHex?: string): string {
  const bytes = keyHex ? Buffer.from(keyHex, "hex") : keyFor(kind)
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16)
}

function envKeyOf(kind: SecretKind): string {
  return SECRET_CONFIG[kind].envKey
}

function readEnvKey(kind: SecretKind, variant?: "new" | "previous"): string | undefined {
  const base = envKeyOf(kind)
  const name = variant ? `${base}_${variant.toUpperCase()}` : base
  const hex = process.env[name]
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return hex
  return undefined
}

/** Clé de chiffrement courante pour un scope (fallback historique JWT_SECRET). */
function keyFor(kind: SecretKind): Buffer {
  const hex = readEnvKey(kind)
  if (hex) return Buffer.from(hex, "hex")
  const fallback = process.env.JWT_SECRET || "dev-insecure-key"
  return createHash("sha256").update(fallback).digest()
}

/** Chiffre avec la clé courante (legacy `iv:tag:data`) ou une clé explicite
 *  (`k<fingerprint>:iv:tag:data` — rotation de clés). */
function encrypt(kind: SecretKind, plain: string, keyHex?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyHex ? Buffer.from(keyHex, "hex") : keyFor(kind), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  const body = `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`
  if (keyHex) return `k${keyFingerprint(kind, keyHex)}:${body}`
  return body
}

/** Déchiffre un payload (nouveau format à empreinte OU legacy). Tentative clé
 *  courante puis précédente — aucun enregistrement n'est perdu pendant la bascule. */
function decrypt(kind: SecretKind, payload: string): string {
  try {
    return decryptInternal(kind, payload, readEnvKey(kind))
  } catch {
    const prev = readEnvKey(kind, "previous")
    if (prev) return decryptInternal(kind, payload, prev)
    throw new Error("format secret invalide")
  }
}

function decryptInternal(kind: SecretKind, payload: string, keyHex?: string): string {
  const parts = payload.split(":")
  // Nouveau format : `k<fingerprint>:iv:tag:data` (4 segments) → la clé atteste
  // l'empreinte. Les payloads legacy `iv:tag:data` (3 segments) restent lisibles.
  let ivHex: string | undefined
  let tagHex: string | undefined
  let dataHex: string | undefined
  if (/^k[0-9a-f]{16}$/.test(parts[0] ?? "") && parts.length === 4) {
    ivHex = parts[1]
    tagHex = parts[2]
    dataHex = parts[3]
  } else if (parts.length === 3) {
    ;[ivHex, tagHex, dataHex] = parts
  } else {
    throw new Error("format secret invalide")
  }
  if (!ivHex || !tagHex || !dataHex) throw new Error("format secret invalide")
  const decipher = createDecipheriv("aes-256-gcm", keyHex ? Buffer.from(keyHex, "hex") : keyFor(kind), Buffer.from(ivHex, "hex"))
  decipher.setAuthTag(Buffer.from(tagHex, "hex"))
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8")
}

/** Chiffre une valeur unique dans le scope "provider" (delta de config
 *  AuthProvider) — à utiliser au lieu de la façade compat `encryptSecret`
 *  (scope "mfa") pour tout secret de provider, sinon la lecture
 *  (`decryptObject`, scope provider) échoue. */
export function encryptProviderSecret(plain: string): string {
  return encrypt("provider", plain)
}

/** Chiffre une valeur dans le scope "backup" (credentials de destination).
 *  Scope distinct de "mfa" : une rotation de clé backup ne casse pas l'auth. */
export function encryptBackupSecret(plain: string): string {
  return encrypt("backup", plain)
}

/** Déchiffre un payload du scope "backup" (clé courante puis précédente). */
export function decryptBackupSecret(payload: string): string {
  return decrypt("backup", payload)
}

/** Chiffre les champs sensibles d'un objet (utilisé pour AuthProvider.config). */
export function encryptObject<T extends Record<string, unknown>>(
  config: T,
  sensitiveFields: string[],
): T {
  const copy = { ...config } as Record<string, unknown>
  for (const field of sensitiveFields) {
    const val = copy[field]
    if (typeof val === "string" && val.length > 0) {
      copy[field] = encrypt("provider", val)
    }
  }
  return copy as T
}

/** Déchiffre les champs sensibles d'un objet (utilisé pour AuthProvider.config). */
export function decryptObject<T extends Record<string, unknown>>(
  config: T,
  sensitiveFields: string[],
): T {
  const copy = { ...config } as Record<string, unknown>
  for (const field of sensitiveFields) {
    const val = copy[field]
    if (typeof val === "string" && val.includes(":")) {
      copy[field] = decrypt("provider", val)
    }
  }
  return copy as T
}

export interface SecretRotationTarget {
  /** Identifiant unique de l'enregistrement (pour rapports d'avancement). */
  ref: string
  /** Payload chiffré ACTUEL (avec ou sans empreinte). */
  encrypted: string
}

export interface SecretRotationResult {
  rotated: number
  skipped: number
  failed: number
}

/**
 * Re-chiffre progressivement les secrets d'un scope avec la NOUVELLE clé
 * (`{ENV}_NEW`, exigée). PAS de big-bang : l'appelant itère enregistrement par
 * enregistrement (boucle paginée dans le script). Les secrets déjà tournés
 * (empreinte = nouvelle clé) sont sautés → le script est idempotent.
 */
export async function rotate(
  kind: SecretKind,
  targets: SecretRotationTarget[],
  rotateAll: (encrypted: string) => Promise<string> | string,
): Promise<SecretRotationResult> {
  const newKey = readEnvKey(kind, "new")
  if (!newKey) {
    throw new Error(`${envKeyOf(kind)}_NEW manquant — rotation impossible`)
  }
  const fp = keyFingerprint(kind, newKey)
  const result: SecretRotationResult = { rotated: 0, skipped: 0, failed: 0 }
  for (const target of targets) {
    try {
      // Déjà tourné (empreinte de la nouvelle clé) → idempotent.
      if (target.encrypted.startsWith(`k${fp}:`)) {
        result.skipped += 1
        continue
      }
      // Déchiffre avec la clé courante (puis "previous" en secours si basculée).
      const plain = decrypt(kind, target.encrypted)
      const reEncrypted = encrypt(kind, plain, newKey)
      await rotateAll(reEncrypted)
      result.rotated += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}

// ── Façade compat ──
// Les appels existants (auth/service, registry/service, lib/keys, lib/ssh-tunnel,
// workflows) conservent leur interface d'origine. La clé utilisée reste celle du
// scope "mfa" pour assurer la compatibilité descendante avec les données existantes.
export function encryptSecret(plain: string): string {
  return encrypt("mfa", plain)
}

export function decryptSecret(storage: string): string {
  return decrypt("mfa", storage)
}
