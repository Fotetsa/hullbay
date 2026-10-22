/**
 * Tant que Membership.roleId est vide, le rôle historique (une chaîne) est relié au
 * preset du même nom dans le tenant. Ce n'est pas une règle métier : on transforme
 * simplement un nom en nom de preset, puis le repository cherche un rôle marqué
 * preset portant ce nom. Aucun droit n'est décidé ici, tout vient des permissions
 * stockées sur ce rôle. Une valeur inconnue ne correspond à aucun preset : aucun
 * droit.
 */
export function legacyRoleToPresetName(legacyRole: string): string | null {
  const trimmed = legacyRole.trim();
  if (!trimmed) return null;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}
