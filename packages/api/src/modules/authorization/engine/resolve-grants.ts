import { legacyRoleToPresetName } from "./legacy-role-resolver";
import type {
  GrantRepository,
  MembershipRecord,
  RoleRecord,
  ScopeRef,
} from "./types";

export type ResolvedGrant = {
  via: "direct" | "team" | "legacy";
  role: RoleRecord;
  teamId?: string;
  /** Pour un rôle d'équipe : le périmètre dans lequel l'équipe reçoit ce rôle. */
  restrictTo?: ScopeRef;
};

/**
 * Rassemble toutes les sources de droits d'une adhésion : rôle direct, rôles des
 * équipes, et à défaut de rôle direct le rôle historique. Les sources s'additionnent.
 * Un rôle direct dont l'identifiant ne se résout plus (supprimé) ne produit rien et
 * ne déclenche pas le repli legacy : on refuse plutôt que de deviner.
 */
export async function resolveGrants(
  repo: GrantRepository,
  membership: MembershipRecord,
): Promise<ResolvedGrant[]> {
  const grants: ResolvedGrant[] = [];

  if (membership.roleId) {
    const role = await repo.findRole(membership.tenantId, membership.roleId);
    if (role) grants.push({ via: "direct", role });
  } else {
    const presetName = legacyRoleToPresetName(membership.legacyRole);
    if (presetName) {
      const role = await repo.findPresetRoleByName(
        membership.tenantId,
        presetName,
      );
      if (role) grants.push({ via: "legacy", role });
    }
  }

  const assignments = await repo.listTeamRoleAssignments(
    membership.tenantId,
    membership.id,
  );
  for (const a of assignments) {
    grants.push({
      via: "team",
      role: a.role,
      teamId: a.teamId,
      restrictTo: { scopeType: a.scopeType, scopeId: a.scopeId },
    });
  }

  return grants;
}
