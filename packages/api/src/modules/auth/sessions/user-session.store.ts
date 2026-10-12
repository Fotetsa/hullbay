import jwt from "jsonwebtoken"
import { prisma } from "../../../lib/prisma"
import { Redis } from "ioredis"
import { randomUUID } from "node:crypto"
import { AuthError } from "../providers/types"
import { jwksService } from "../jwks/jwks.service"
import { securityPolicy } from "../policies/security-policy.service"
import { DEFAULT_TENANT_ID } from "../identity/auth-identity.service"

export interface SessionHandle {
  sub: string
  role: string
  mfaEnabled: boolean
  tenantId?: string
  /** jti de la session — nécessaire pour identifier la session courante côté
   *  requêtes (create.guard → req.user.jti). Optionnel pour tolérer les
   *  payloads en cache (Redis/mémoire) émis par une version antérieure. */
  jti?: string
}

export interface SessionStore {
  signSession(userId: string, role: string, mfaEnabled: boolean, providerId?: string, tenantId?: string): string
  verifySession(token: string): SessionHandle
  signPending(userId: string, tenantId: string): string
  verifyPending(token: string): { sub: string; tenantId: string }
  revoke(jti: string): Promise<void>
  revokeUserSessions(userId: string, notJti?: string): Promise<void>
}

const AUD_SESSION = "session"
const AUD_MFA_PENDING = "mfa-pending"
const PENDING_TTL = "5m"
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** Au-delà, purge des entrées expirées (prévention fuite mémoire). */
const CACHE_PRUNE_THRESHOLD = 10_000
/** Fréquence minimale de mise à jour de `lastSeenAt` (anti write-per-request). */
const TOUCH_INTERVAL_MS = 60_000

// Redis PRÉ-REQUISE : sans REDIS_URL, pas d'instance — le store retombe sur
// la mémoire + la DB (source de vérité). Une URL par défaut encourageait des
// connexions fantômes vers un daemon absent. Erreur de connection loggée (pas
// crash) : le store doit continuer en mode dégradé mémoire/DB.
const redis: Redis | null = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
  : null
if (redis) {
  redis.on("error", (err: Error) => {
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[sessions] redis indisponible : ${err.message}`)
    }
  })
}
const activeSessions = new Map<string, { handle: SessionHandle; expiresAt: number }>()
const lastTouched = new Map<string, number>()
// JTI révoqués dans ce process : permet une vérification SYNCHRONE (le fast-path
// cache de verifySession ne repasse pas par la DB). Sans ce set, un token révoqué
// restait accepté jusqu'à expiration du cache (12 h). Valeur = timestamp d'expiration.
const revokedJtis = new Map<string, number>()

function legacySecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error("JWT_SECRET requis pour signer les tokens MFA")
  return secret
}

/** TTL de session issu de la policy (tenant précis au sign, défaut sinon). */
function sessionTtlMs(tenantId: string = DEFAULT_TENANT_ID): number {
  const ttl = securityPolicy.getPolicyCached(tenantId).sessionTtlMs
  return typeof ttl === "number" && ttl > 0 ? ttl : SESSION_TTL_MS
}

/** TTL restant d'un token décodé (exp), sinon TTL policy. */
function ttlFromDecoded(decoded: { exp?: number }): number {
  if (typeof decoded.exp === "number") return Math.max(0, decoded.exp * 1000 - Date.now())
  return sessionTtlMs()
}

/** Evince les entrées expirées (appelé quand les caches grossissent ou au fast-path). */
function pruneCaches(now = Date.now()): void {
  for (const [jti, expiresAt] of revokedJtis) {
    if (expiresAt <= now) revokedJtis.delete(jti)
  }
  for (const [jti, entry] of activeSessions) {
    if (entry.expiresAt <= now) activeSessions.delete(jti)
  }
  for (const [jti, seenAt] of lastTouched) {
    if (seenAt + TOUCH_INTERVAL_MS <= now) lastTouched.delete(jti)
  }
}

/** Met à jour `lastSeenAt` au plus une fois par TOUCH_INTERVAL_MS et par jti. */
function touchSession(jti: string): void {
  const now = Date.now()
  const previous = lastTouched.get(jti)
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return
  lastTouched.set(jti, now)
  if (prisma.userSession) {
    prisma.userSession.update({ where: { jti }, data: { lastSeenAt: new Date() } }).catch(() => {})
  }
}

function redisReady(): boolean {
  return Boolean(redis && redis.status === "ready")
}

async function cacheSession(jti: string, data: SessionHandle, ttlMs: number): Promise<void> {
  revokedJtis.delete(jti)
  activeSessions.set(jti, { handle: data, expiresAt: Date.now() + ttlMs })
  if (activeSessions.size > CACHE_PRUNE_THRESHOLD) pruneCaches()
  if (redisReady()) await redis!.set(`sess:${jti}`, JSON.stringify(data), "EX", Math.floor(ttlMs / 1000))
}

async function markRevoked(jti: string, ttlMs: number): Promise<void> {
  revokedJtis.set(jti, Date.now() + ttlMs)
  activeSessions.delete(jti)
  if (revokedJtis.size > CACHE_PRUNE_THRESHOLD) pruneCaches()
  if (redisReady()) await redis!.set(`revoked:${jti}`, "1", "EX", Math.floor(ttlMs / 1000))
}

/**
 * Réconciliation asynchrone sur cache-miss (redémarrage process, autre instance).
 * Ne bloque jamais la vérification synchrone. La révocation inter-process passe
 * par Redis quand il est disponible, puis par la DB (source de vérité).
 */
function reconcile(jti: string, decoded: { sub?: string; role?: string; mfaEnabled?: boolean; exp?: number; providerId?: string; tenantId?: string }): void {
  void (async () => {
    try {
      if (!prisma.userSession) return
      if (redisReady()) {
        const revoked = await redis!.get(`revoked:${jti}`).catch(() => null)
        if (revoked) {
          await markRevoked(jti, SESSION_TTL_MS)
          return
        }
      }

      const ttl = ttlFromDecoded(decoded)
      const session = await prisma.userSession.findUnique({ where: { jti } })
      if (!session) {
        // Session active sans row : backfill MAIS seulement si
        // l'utilisateur existe encore — sinon un token d'un compte supprimé
        // ressusciterait une session. `undefined` = vérification indisponible,
        // on tolère le backfill ; `null` = compte absent, on révoque.
        let owner: { id: string } | null | undefined
        if (prisma.user?.findUnique) {
          try {
            owner = await prisma.user.findUnique({ where: { id: decoded.sub! }, select: { id: true } })
          } catch {
            owner = undefined
          }
        }
        if (owner === null) {
          await markRevoked(jti, ttl)
          return
        }
        const expiresAt = decoded.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + ttl)
        await prisma.userSession
          .create({ data: { jti, userId: decoded.sub!, providerId: decoded.providerId ?? "local", expiresAt } })
          .catch(() => {})
await cacheSession(jti, { sub: decoded.sub!, role: decoded.role!, mfaEnabled: decoded.mfaEnabled ?? false, tenantId: decoded.tenantId ?? DEFAULT_TENANT_ID, jti }, ttl)
        return
      }

      if (session.revokedAt || session.expiresAt <= new Date()) {
        await markRevoked(jti, ttl)
        return
      }

      await cacheSession(jti, { sub: decoded.sub!, role: decoded.role!, mfaEnabled: decoded.mfaEnabled ?? false, tenantId: decoded.tenantId ?? DEFAULT_TENANT_ID, jti }, ttl)
      touchSession(jti)
    } catch {
      // best-effort : la vérification synchrone a déjà répondu
    }
  })()
}

export class UserSessionStore implements SessionStore {
  signSession(userId: string, role: string, mfaEnabled: boolean, providerId = "local", tenantId = DEFAULT_TENANT_ID): string {
    const jti = randomUUID()
    const ttl = sessionTtlMs(tenantId)
    const expiresAt = new Date(Date.now() + ttl)
    const token = jwksService.signPayload(
      { sub: userId, role, mfaEnabled, jti, providerId, tenantId },
      { expiresIn: Math.floor(ttl / 1000), audience: AUD_SESSION },
    )
    const handle: SessionHandle = { sub: userId, role, mfaEnabled, tenantId, jti }
    if (prisma.userSession) prisma.userSession.create({ data: { jti, userId, providerId, expiresAt } }).catch(() => {})
    cacheSession(jti, handle, ttl).catch(() => {})
    return token
  }

  verifySession(token: string): SessionHandle {
    const decoded = jwksService.verifyToken(token, AUD_SESSION) as {
      sub?: string
      role?: string
      mfaEnabled?: boolean
      jti?: string
      exp?: number
      providerId?: string
      tenantId?: string
    }
    if (!decoded.sub || !decoded.role) throw new Error("token de session invalide")

    const jti = decoded.jti
    if (!jti) throw new Error("token de session sans jti")

    const now = Date.now()
    if (revokedJtis.size + activeSessions.size > CACHE_PRUNE_THRESHOLD) pruneCaches(now)

    // Révocation : refus immédiat (fast-path compris) si le jti a été révoqué
    // dans ce process. Couvre le cas « l'utilisateur révoque puis rejoue son token ».
    if (revokedJtis.has(jti)) throw new Error("session révoquée")

    const cached = activeSessions.get(jti)
    if (cached) {
      touchSession(jti)
      // Garantit le jti y compris si le handle en cache provient d'un payload
      // émis par une version antérieure (doté de la clé de Map, toujours là).
      return { ...cached.handle, jti }
    }

    reconcile(jti, decoded)
    return {
      sub: decoded.sub,
      role: decoded.role,
      mfaEnabled: decoded.mfaEnabled ?? false,
      tenantId: decoded.tenantId ?? DEFAULT_TENANT_ID,
      jti,
    }
  }

  async revokeUserSessions(userId: string, notJti?: string): Promise<void> {
    const nowMs = Date.now()
    // Cache mémoire : invalidation synchrone (fast-path avant tout await).
    for (const [jti, entry] of [...activeSessions]) {
      if (entry.handle.sub !== userId) continue
      if (jti === notJti) continue
      activeSessions.delete(jti)
      revokedJtis.set(jti, entry.expiresAt)
    }
    // Redis : invalidation par pattern (toutes les sessions actives de l'user).
    if (redisReady()) {
      const keys = await redis!.keys(`sess:*`).catch(() => [] as string[])
      for (const key of keys) {
        const jti = key.startsWith("sess:") ? key.slice(5) : key
        if (jti === notJti) continue
        const raw = await redis!.get(key).catch(() => null)
        if (!raw) continue
        try {
          const handle = JSON.parse(raw) as SessionHandle
          if (handle.sub === userId) {
            await redis!.del(key).catch(() => {})
          }
        } catch { /* ignore */ }
      }
    }
    // DB : source de vérité — toutes les sessions actives non expirées de l'user.
    if (prisma.userSession) {
      await prisma.userSession.updateMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() }, ...(notJti ? { jti: { not: notJti } } : {}) },
        data: { revokedAt: new Date() },
      }).catch(() => {})
    }
  }

  async revoke(jti: string): Promise<void> {
    // Invalidation synchrone du cache (revokedJtis.add / activeSessions.delete
    // s'exécutent avant le 1er await) → effet immédiat sur le fast-path.
    markRevoked(jti, SESSION_TTL_MS).catch(() => {})
    if (prisma.userSession) {
      prisma.userSession.update({ where: { jti }, data: { revokedAt: new Date() } }).catch(() => {})
    }
  }

  signPending(userId: string, tenantId: string): string {
    return jwt.sign({ sub: userId, mfa: "pending", tenantId }, legacySecret(), {
      expiresIn: PENDING_TTL,
      audience: AUD_MFA_PENDING,
    })
  }

  verifyPending(token: string): { sub: string; tenantId: string } {
    let decoded: { sub?: string; mfa?: string; tenantId?: string }
    try {
      decoded = jwt.verify(token, legacySecret(), { audience: AUD_MFA_PENDING }) as { sub?: string; mfa?: string; tenantId?: string }
    } catch {
      throw new AuthError("mfa_token_invalid", "token MFA invalide", 401)
    }
    // tenantId obligatoire : la config WebAuthn/MFA est résolue au tenant du
    // pending token. Un token sans claim (émission antérieure) est rejeté —
    // jamais de fallback silencieux vers DEFAULT_TENANT_ID.
    if (decoded.mfa !== "pending" || !decoded.sub || !decoded.tenantId) {
      throw new AuthError("mfa_token_invalid", "token MFA invalide", 401)
    }
    return { sub: decoded.sub, tenantId: decoded.tenantId }
  }
}

export const userSessionStore: SessionStore = new UserSessionStore()
