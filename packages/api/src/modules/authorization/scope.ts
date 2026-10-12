/**
 * Types de scope reconnus. Ce n'est volontairement pas un enum Prisma :
 * ajouter une ressource autorisable ne doit pas exiger de migration SQL.
 * La validation se fait ici, dans le code.
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

/** Le scope « tout le tenant » s'écrit tenant:<tenantId>, jamais avec une valeur vide. */
export function tenantScope(tenantId: string): {
  scopeType: "tenant";
  scopeId: string;
} {
  return { scopeType: "tenant", scopeId: tenantId };
}
