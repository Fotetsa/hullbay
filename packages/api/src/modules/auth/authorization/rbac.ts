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

type LegacyVerdict = {
  allowed: boolean
  tenantId: string
  /** Rôle effectif résolu depuis la membership du tenant courant */
  role: Role
  /** Rang du rôle revendiqué par le token. */
  tokenRank: number
}

/**
 * Calcul pur du verdict legacy, sans effet de bord (pas de réponse, pas d'audit).
 * Partagé par requireRole et evaluateLegacyRole pour ne dupliquer aucune logique.
 *
 * Le rôle est toujours rebasé sur la vérité DB du tenant demandé : cela corrige les
 * tokens hérités ou obsolètes et empêche qu'un owner du tenant A passe owner ailleurs.
 */

async function legacyVerdict(
  req: FastifyRequest,
  user: { sub: string; role: Role },
  min: Role,
): Promise<LegacyVerdict> {
  const t = req as unknown as { tenantId?: string; user?: { tenantId?: string } }
  const tenantId = t.tenantId ?? t.user?.tenantId ?? DEFAULT_TENANT_ID

  const effectiveRole = await resolveRoleForUser(user.sub, tenantId, user.role)
  const role = (effectiveRole || user.role) as Role

  const rank = RANK[role] ?? UNKNOWN_ROLE_RANK
  const tokenRank = RANK[user.role] ?? UNKNOWN_ROLE_RANK
  return { allowed: rank >= RANK[min], tenantId, role, tokenRank }
}

/**
 * preHandler Fastify : exige au moins le rôle `min`. À attacher sur les routes
 * sensibles, ex: `{ preHandler: requireRole("operator") }`.
 */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = (req as AuthedRequest).user;
    if (!user) return reply.code(401).send({ error: "non authentifié" });

    const verdict = await legacyVerdict(req, user, min);
    if (!verdict.allowed) {
      // Rôle effectif sous le minimum sur le tenant demandé (ex. rôle legacy obsolète
      // du token) : rejet cross-tenant audité (#170).
      await eventBus.emit(AUTH_AUDIT_EVENTS.tenantForbidden, {
        userId: user.sub,
        tenantId: verdict.tenantId,
        requiredRole: min,
        effectiveRole: verdict.role,
        reason: "insufficient_role",
      });
      // Downgrade cross-tenant : le token revendiquait un rôle assez élevé mais la
      // résolution le rabote sur ce tenant, d'où un code exposé pour l'i18n front.
      // Un manque de rôle banal garde le 403 générique sans code.
      const staleEscalation = verdict.tokenRank >= RANK[min];
      return reply.code(403).send({
        error: "permission insuffisante",
        ...(staleEscalation ? { code: "tenant_forbidden" } : {}),
      });
    }
  };
}

/**
 * Verdict legacy en lecture seule, pour le mode shadow de la Phase 3 : ne répond pas
 * et n'émet aucun audit. Dette retirée en Phase 7 avec requireRole.
 */
export async function evaluateLegacyRole(req: FastifyRequest, min: Role): Promise<boolean> {
  const user = (req as AuthedRequest).user
  if (!user) return false
  return (await legacyVerdict(req, user, min)).allowed
}

/** Récupère l'utilisateur courant (après la garde). */
export function currentUser(req: FastifyRequest): { sub: string; role: Role } | undefined {
  return (req as AuthedRequest).user
}
