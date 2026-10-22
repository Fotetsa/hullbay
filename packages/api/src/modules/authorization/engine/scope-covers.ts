import { isValidScopeType } from "../scope";
import type { ResourceRecord } from "./types";

export type CoverageContext = {
  tenantId: string;
  resource?: ResourceRecord;
  /** Types de scope acceptés pour la permission, "tenant" toujours inclus. */
  accepted: ReadonlySet<string>;
};

/**
 * Dit si un scope couvre la cible de l'action. Un scope de type inconnu, ou de type
 * non accepté par la permission, ne couvre rien. Le scope tenant couvre tout le
 * tenant, un scope de même type couvre exactement sa ressource, et un scope
 * d'ancêtre ne couvre que si la permission l'accepte (donc que le catalogue l'a
 * déclaré). Une action sans ressource n'est couverte que par le scope tenant.
 */
export function scopeCovers(
  scopeType: string,
  scopeId: string,
  ctx: CoverageContext,
): boolean {
  if (!isValidScopeType(scopeType)) return false;
  if (!ctx.accepted.has(scopeType)) return false;

  if (scopeType === "tenant") return scopeId === ctx.tenantId;
  if (!ctx.resource) return false;
  if (scopeType === ctx.resource.type) return scopeId === ctx.resource.id;
  return ctx.resource.parents[scopeType] === scopeId;
}
