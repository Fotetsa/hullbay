import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto"
import jwt from "jsonwebtoken"
import { generateSecret, generateURI, verify as totpVerify } from "otplib"
import { prisma } from "../../lib/prisma"
import { encryptSecret, decryptSecret } from "./crypto"
import type { Role } from "./rbac"

/**
 * Auth de l'ops-panel : compte unique (owner) en V1, mais le modèle User/rôles
 * est prêt pour la délégation (V2). MFA TOTP OBLIGATOIRE dès la V1 (cf. plan :
 * docker.sock = root, on impose le second facteur).
 *
 * NB : otplib v13 — API `authenticator` (generateSecret/keyuri/verify). Si une
 * autre version est résolue, adapter ici.
 */

const TOKEN_TTL = "12h"

// Audiences distinctes : un token de pré-auth MFA ne doit JAMAIS être accepté
// comme token de session (sinon MFA contournable avec le seul mot de passe).
const AUD_SESSION = "session"
const AUD_MFA_PENDING = "mfa-pending"

function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString("hex")
  const derived = scryptSync(password, s, 64).toString("hex")
  return `${s}:${derived}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const derived = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, "hex")
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

export class AuthService {
  /** Crée le compte owner initial (idempotent : refuse si un owner existe déjà). */
  async createOwner(email: string, password: string) {
    const existing = await prisma.user.findFirst({ where: { role: "owner" } })
    if (existing) throw new Error("un compte owner existe déjà")
    return prisma.user.create({
      data: { email, passwordHash: hashPassword(password), role: "owner" },
    })
  }

  /**
   * Étape 1 du login : vérifie email+password. Si MFA activée, renvoie mfaRequired
   * (le front demandera le code TOTP) ; sinon délivre le token directement.
   */
  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new Error("identifiants invalides")
    }
    if (user.mfaEnabled) {
      // Token court de "pré-auth" : audience dédiée mfa-pending, JAMAIS acceptée
      // comme session par verifyToken (cf. revue sécu : sinon MFA contournable).
      const pending = jwt.sign(
        { sub: user.id, mfa: "pending" },
        process.env.JWT_SECRET as string,
        { expiresIn: "5m", audience: AUD_MFA_PENDING }
      )
      return { mfaRequired: true as const, pendingToken: pending }
    }
    return { mfaRequired: false as const, token: this.issueToken(user.id, user.role, false) }
  }

  /** Étape 2 du login : vérifie le code TOTP et délivre le token de session. */
  async verifyMfa(pendingToken: string, code: string) {
    // Exige l'audience mfa-pending : un token de session ne peut pas servir ici,
    // et inversement (les deux audiences sont cloisonnées).
    const decoded = jwt.verify(pendingToken, process.env.JWT_SECRET as string, {
      audience: AUD_MFA_PENDING,
    }) as {
      sub?: string
      mfa?: string
    }
    if (decoded.mfa !== "pending" || !decoded.sub) throw new Error("token MFA invalide")
    const user = await prisma.user.findUniqueOrThrow({ where: { id: decoded.sub } })
    if (!user.mfaSecretEnc) throw new Error("MFA non configurée")
    const secret = decryptSecret(user.mfaSecretEnc)
    if (!(await totpVerify({ token: code, secret, epochTolerance: 30 })).valid) {
      throw new Error("code invalide")
    }
    return { token: this.issueToken(user.id, user.role, true) }
  }

  /** Démarre l'enrôlement MFA : génère un secret + l'otpauth URI (QR côté front). */
  async startMfaEnrollment(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    const secret = generateSecret({ length: 20 })
    // Stocké chiffré, MFA pas encore "enabled" tant que non confirmée.
    await prisma.user.update({
      where: { id: userId },
      data: { mfaSecretEnc: encryptSecret(secret) },
    })
    const otpauth = generateURI({
      strategy: "totp",
      issuer: "Bozando Ops",
      label: user.email,
      secret,
    })
    return { otpauth, secret }
  }

  /** Confirme l'enrôlement : vérifie un 1er code puis active la MFA. */
  async confirmMfaEnrollment(userId: string, code: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (!user.mfaSecretEnc) throw new Error("aucun enrôlement en cours")
    const secret = decryptSecret(user.mfaSecretEnc)
    if (!(await totpVerify({ token: code, secret, epochTolerance: 30 })).valid) {
      throw new Error("code invalide")
    }
    await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } })
    return { ok: true, token: this.issueToken(userId, user.role, true) }
  }

  /**
   * Change le mot de passe d'un utilisateur authentifié : exige le mot de passe
   * ACTUEL (anti-détournement si la session est volée), puis enregistre le hash du
   * nouveau. Le nouveau mot de passe n'est jamais journalisé.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new Error("mot de passe actuel incorrect")
    }
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashPassword(newPassword) },
    })
    return { ok: true }
  }

  /** Nombre de comptes existants — sert au bootstrap (0 = installation neuve). */
  async countUsers(): Promise<number> {
    return prisma.user.count()
  }

  /** Liste les comptes (jamais le hash ni le secret MFA) — gestion des utilisateurs. */
  async listUsers() {
    const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } })
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      mfaEnabled: u.mfaEnabled,
      createdAt: u.createdAt,
    }))
  }

  /**
   * Crée un compte délégué (operator/viewer) avec un mot de passe initial. L'owner
   * ne peut PAS créer un autre owner par cette voie (le 1er owner vient du bootstrap ;
   * la promotion owner passe par setRole, explicite). Le hash n'est jamais journalisé.
   */
  async createUser(email: string, password: string, role: "operator" | "viewer") {
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) throw new Error("un compte avec cet email existe déjà")
    const u = await prisma.user.create({
      data: { email, passwordHash: hashPassword(password), role },
    })
    return { id: u.id, email: u.email, role: u.role }
  }

  /**
   * Change le rôle d'un compte. Garde-fou : on ne peut pas rétrograder le DERNIER
   * owner (sinon plus personne ne peut administrer = lockout définitif).
   */
  async setRole(userId: string, role: Role) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (user.role === "owner" && role !== "owner") {
      const owners = await prisma.user.count({ where: { role: "owner" } })
      if (owners <= 1) throw new Error("impossible de rétrograder le dernier owner")
    }
    const u = await prisma.user.update({ where: { id: userId }, data: { role } })
    return { id: u.id, email: u.email, role: u.role }
  }

  /**
   * Supprime un compte. Garde-fous : pas d'auto-suppression (on se verrouillerait
   * hors de la session courante), et jamais le dernier owner.
   */
  async deleteUser(userId: string, actingUserId: string) {
    if (userId === actingUserId) throw new Error("impossible de supprimer son propre compte")
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    if (user.role === "owner") {
      const owners = await prisma.user.count({ where: { role: "owner" } })
      if (owners <= 1) throw new Error("impossible de supprimer le dernier owner")
    }
    await prisma.user.delete({ where: { id: userId } })
    return { ok: true as const }
  }

  issueToken(userId: string, role: string, mfaEnabled: boolean): string {
    // Audience session : seul ce type de token est accepté par verifyToken / la
    // garde /api/* / le handshake WebSocket.
    return jwt.sign({ sub: userId, role, mfaEnabled }, process.env.JWT_SECRET as string, {
      expiresIn: TOKEN_TTL,
      audience: AUD_SESSION,
    })
  }

  verifyToken(token: string): { sub: string; role: string; mfaEnabled: boolean } {
    // audience: AUD_SESSION rejette tout token mfa-pending (jwt lève si aud != session).
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string, {
      audience: AUD_SESSION,
    }) as { sub?: string; role?: string; mfa?: string; mfaEnabled?: boolean };
    if (decoded.mfa || !decoded.role || !decoded.sub) {
      throw new Error("token de session invalide")
    }
    return {
      sub: decoded.sub,
      role: decoded.role,
      mfaEnabled: decoded.mfaEnabled ?? false
    };
  }
}

export const authService = new AuthService()
