import type { Subject } from "./engine/types";

/**
 * Forme minimale d'une session authentifiée. Elle correspond au `req.user` posé par
 * la garde d'authentification (sub + tenantId du token signé), sans importer le
 * module auth : le moteur reste indépendant de la manière dont on s'authentifie.
 */
export type AuthenticatedSession = { sub: string; tenantId?: string };

/**
 * Chemin canonique de construction d'un Subject. Prend UNIQUEMENT la session
 * authentifiée : il n'existe volontairement aucun paramètre permettant de passer un
 * tenant fourni par le client. Une session sans tenant ou sans identifiant est refusée
 * (jamais de tenant par défaut implicite).
 */
export function subjectFromSession(
  session: AuthenticatedSession | null | undefined,
): Subject {
  if (!session?.sub || !session.tenantId) {
    throw new Error("session invalide : identifiant ou tenant manquant");
  }
  return { userId: session.sub, tenantId: session.tenantId };
}
