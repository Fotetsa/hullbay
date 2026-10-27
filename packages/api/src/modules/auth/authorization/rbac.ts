/**
 * RBAC — autorisation par rôle (déplacé depuis modules/auth/rbac.ts).
 * Rôle résolu via la Membership du tenant courant, repli legacy `User.role`.
 *
 * Rôles : owner (tout) > operator (projets + deploy/destroy) > viewer (lecture).
 */

import type { FastifyRequest, FastifyReply } from "fastify"
import { DEFAULT_TENANT_ID, resolveRoleForUser } from "../identity/auth-identity.service"
import { eventBus } from "../../../lib/event-bus"
import { AUTH_AUDIT_EVENTS } from "../audit-events"

export type Role = "owner" | "operator" | "viewer"

// Stand: un rôle inconnu (absent de RANK) est traité comme viewer (fail-closed :
// toute valeur hors enum ne peut PAS dépasser la garde requireRole). Voir note rbac.
const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }
const UNKNOWN_ROLE_RANK = 0 // rang le plus bas : un rôle non-enum ne gagne jamais de permission

type AuthedRequest = FastifyRequest & { user?: { sub: string; role: Role } }

/**
 * preHandler Fastify : exige au moins le rôle `min`. À attacher sur les routes
 * sensibles, ex: `{ preHandler: requireRole("operator") }`.
 */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = (req as AuthedRequest).user
    if (!user) return reply.code(401).send({ error: "non authentifié" })

    const t = req as unknown as { tenantId?: string; user?: { tenantId?: string } }
    const tenantId = t.tenantId ?? t.user?.tenantId ?? DEFAULT_TENANT_ID

    // Résolution de l'autorisation effective à partir de la membership du tenant
    // courant. Cela corrige les tokens hérités / sessions stoquées avec un rôle
    // obsolète après un changement de modèle auth ou de tenant ; on refuse le
    // fail-open et on rebase toujours sur la vérité DB du tenant demandé.
    const effectiveRole = await resolveRoleForUser(user.sub, tenantId, user.role)
    const role = effectiveRole || user.role

    // Privilège cross-tenant : si un header résout un AUTRE tenant que
    // celui du token, le rôle signé ne vaut pas là-bas → on résout la membership
    // du tenant cible, sinon un owner tenant-A passerait owner partout (tenancy
    // fantôme). Même tenant → on se base sur la vérité DB pour corriger les
    // tokens legacy.
const rank = RANK[role] ?? UNKNOWN_ROLE_RANK
    const tokenRank = RANK[user.role] ?? UNKNOWN_ROLE_RANK
    if (rank < RANK[min]) {
      // Rôle effectif sous le minimum sur le tenant demandé (ex. rôle legacy
      // obsolète du token) → rejet cross-tenant audité — #170.
      await eventBus.emit(AUTH_AUDIT_EVENTS.tenantForbidden, {
        userId: user.sub,
        tenantId,
        requiredRole: min,
        effectiveRole: role,
        reason: "insufficient_role",
      })
      // Downgrade cross-tenant : le token revendiquait un rôle assez élevé
      // (owner/operator) mais la résolution fail-closed le rabote sur ce tenant
      // → code exposé pour l'i18n front. Un manque de rôle banal (viewer sur
      // SON tenant) garde le 403 générique sans code.
      const staleEscalation = tokenRank >= RANK[min]
      return reply.code(403).send({
        error: "permission insuffisante",
        ...(staleEscalation ? { code: "tenant_forbidden" } : {}),
      })
    }
  }
}

/** Récupère l'utilisateur courant (après la garde). */
export function currentUser(req: FastifyRequest): { sub: string; role: Role } | undefined {
  return (req as AuthedRequest).user
}
