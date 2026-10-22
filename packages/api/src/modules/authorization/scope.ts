/**
 * CONVENTION CANONIQUE DU SCOPE TENANT.
 *
 * Le scope « tout le tenant » est représenté uniquement par :
 *     scopeType = "tenant"   et   scopeId = <tenantId>
 * Il n'existe aucune autre représentation (pas de scopeId NULL, pas de chaîne
 * vide, pas de "*"). Les colonnes scopeType/scopeId sont NOT NULL en base, et le
 * moteur ne reconnaît que cette forme : un scope tenant dont scopeId n'est pas
 * l'identifiant du tenant du sujet ne couvre rien.
 *
 * Utilise toujours tenantScope(tenantId) pour l'écrire.
 *
 * Les types de scope ne sont volontairement pas un enum Prisma : ajouter une
 * ressource autorisable ne doit pas exiger de migration SQL. Le refus d'un type
 * inconnu est porté ici.
 */
export const SCOPE_TYPES = [
  "tenant",
  "cluster",
  "server",
  "project",
  "node",
  "edge",
] as const;

export type ScopeType = (typeof SCOPE_TYPES)[number];

export function isValidScopeType(value: string): value is ScopeType {
  return (SCOPE_TYPES as readonly string[]).includes(value);
}

export function tenantScope(tenantId: string): {
  scopeType: "tenant";
  scopeId: string;
} {
  return { scopeType: "tenant", scopeId: tenantId };
}
