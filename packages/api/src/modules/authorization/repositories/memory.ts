import type {
  GrantRepository,
  MembershipRecord,
  ResourceRecord,
  ResourceRepository,
  RoleRecord,
  TeamRoleAssignment,
} from "../engine/types";
import { legacyRoleToPresetName } from "../engine/legacy-role-resolver";
import type { ScopeType } from "../scope";

export type MemoryGrantData = {
  memberships: MembershipRecord[];
  roles: (RoleRecord & { isPreset?: boolean })[];
  teamMembers: { teamId: string; tenantId: string; membershipId: string }[];
  teamRoles: {
    teamId: string;
    tenantId: string;
    roleId: string;
    scopeType: string;
    scopeId: string;
  }[];
};

/** Implémentation en mémoire pour les tests : reproduit le filtrage par tenant de la base. */
export class MemoryGrantRepository implements GrantRepository {
  constructor(public data: MemoryGrantData) {}

  async findMembership(userId: string, tenantId: string) {
    return (
      this.data.memberships.find(
        (m) => m.userId === userId && m.tenantId === tenantId,
      ) ?? null
    );
  }

  async findRole(tenantId: string, roleId: string) {
    return (
      this.data.roles.find((r) => r.id === roleId && r.tenantId === tenantId) ??
      null
    );
  }

  async findPresetRoleByName(tenantId: string, name: string) {
    const wanted = legacyRoleToPresetName(name);
    return (
      this.data.roles.find(
        (r) =>
          r.tenantId === tenantId &&
          r.isPreset === true &&
          legacyRoleToPresetName(r.name) === wanted,
      ) ?? null
    );
  }

  async listTeamRoleAssignments(
    tenantId: string,
    membershipId: string,
  ): Promise<TeamRoleAssignment[]> {
    const teamIds = new Set(
      this.data.teamMembers
        .filter(
          (t) => t.tenantId === tenantId && t.membershipId === membershipId,
        )
        .map((t) => t.teamId),
    );
    const out: TeamRoleAssignment[] = [];
    for (const tr of this.data.teamRoles) {
      if (tr.tenantId !== tenantId || !teamIds.has(tr.teamId)) continue;
      const role = this.data.roles.find(
        (r) => r.id === tr.roleId && r.tenantId === tenantId,
      );
      if (role)
        out.push({
          teamId: tr.teamId,
          scopeType: tr.scopeType,
          scopeId: tr.scopeId,
          role,
        });
    }
    return out;
  }
}

export class MemoryResourceRepository implements ResourceRepository {
  constructor(public resources: ResourceRecord[]) {}

  async load(type: ScopeType, id: string) {
    return this.resources.find((r) => r.type === type && r.id === id) ?? null;
  }
}
