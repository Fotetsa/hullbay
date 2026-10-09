/**
 * Garde d'authentification sur /api/* (déplacée depuis routes.ts, comportement identique).
 * Tout /api/* est protégé SAUF les routes publiques (login, mfa/verify, bootstrap,
 * needs-bootstrap) et les routes MFA_SETUP qui acceptent un token mfa-pending valide
 * ou un token de session.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { authService } from "../service"
import { sessionManager } from "../core/session-manager"
import { assertUserInTenant, DEFAULT_TENANT_ID, ensureUserHasDefaultMembership } from "../identity/auth-identity.service"
import { effectiveTenantId, tenantFromHeader } from "../tenancy/tenant-resolver"
import { eventBus } from "../../../lib/event-bus"
import { AUTH_AUDIT_EVENTS } from "../audit-events"

const PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/mfa/verify",
  "/api/auth/mfa/webauthn/auth/options",
  "/api/auth/mfa/webauthn/auth/verify",
  "/api/auth/bootstrap",
  "/api/auth/needs-bootstrap",
  // Liste des providers activés (login sans token).
  "/api/auth/providers",
  "/api/system/environment",
])

// Flux SSO (initiateLogin + callback) et LDAP : routes à préfixe dynamique.
// Reconnaît oidc/oauth2 (sso), saml et ldap.
const PUBLIC_PATH_PREFIXES = ["/api/auth/sso/", "/api/auth/saml/", "/api/auth/ldap/"]

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true
  return PUBLIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))
}

const MFA_SETUP_PATHS = new Set([
  "/api/auth/mfa/enroll",
  "/api/auth/mfa/confirm",
  "/api/auth/mfa/webauthn/register/options",
  "/api/auth/mfa/webauthn/register/verify",
  "/api/auth/mfa/webauthn/credentials",
  "/api/auth/me",
  // C7 : changer de tenant n'a pas besoin de re-MFA (l'utilisateur détient déjà
  // une session MFA dans le tenant courant) ; il faut juste le laisser atteindre
  // cette route quand sa session est "setup" (mfaEnabled=false).
  "/api/auth/session/switch-tenant",
])

function isMfaSetupPath(path: string): boolean {
  if (MFA_SETUP_PATHS.has(path)) return true
  if (path.startsWith("/api/auth/mfa/webauthn/credentials/")) return true
  return false
}

export function registerAuthGuard(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return

    const path = req.url.split("?")[0] ?? ""
    if (isPublicPath(path)) return

    const header = req.headers.authorization
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined
    if (!token) return reply.code(401).send({ error: "non authentifié" })

    try {
      // Session authentifiée — vérifie via la façade authService (mockable en tests).
      const decoded = authService.verifyToken(token) as {
        sub: string
        role: string
        mfaEnabled: boolean
        tenantId?: string
        jti?: string
      }

      // Tenancy à la requête. Override cross-tenant via header : résolu
      // seulement si l'utilisateur a une membership dans ce tenant (fail-closed).
      const headerTenant = tenantFromHeader(req)
      if (headerTenant) {
        const allowed = await assertUserInTenant(decoded.sub, headerTenant)
        if (!allowed) {
          // Tente d'accéder à un tenant où l'utilisateur n'a AUCUNE membership
          // (même un token owner ne passe pas : fail-closed). Audité — #170.
          await eventBus.emit(AUTH_AUDIT_EVENTS.tenantForbidden, {
            userId: decoded.sub,
            tenantId: headerTenant,
            reason: "no_membership",
          })
          return reply
            .code(403)
            .send({ error: "accès refusé à ce tenant", code: "tenant_forbidden" })
        }
      }

      const request = req as FastifyRequest & {
        user?: unknown
        tenantId?: string
      }

      request.user = { ...decoded, tenantId: decoded.tenantId ?? DEFAULT_TENANT_ID }
      request.tenantId = effectiveTenantId(req)

      if (request.tenantId === DEFAULT_TENANT_ID) {
        await ensureUserHasDefaultMembership(decoded.sub).catch(() => undefined)
      }

      // MFA non activée : seules les routes de setup sont accessibles
      if (!decoded.mfaEnabled && !isMfaSetupPath(path)) {
        return reply.code(403).send({
          error: "MFA non activée — active la MFA avant de continuer.",
          code: "mfa_not_enabled",
        })
      }
    } catch {
      // Un pendingToken (audience mfa-pending) ou un token
      // invalide est rejeté partout, y compris sur les routes de setup MFA. Les
      // routes MFA_SETUP acceptent exclusivement un token de session valide.
      return reply.code(401).send({ error: "token invalide" })
    }
  })
}
