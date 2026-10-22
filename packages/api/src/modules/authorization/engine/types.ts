import type { ScopeType } from "../scope";
import type { CatalogEntry } from "../catalog/resource-catalog";

export type Subject = { userId: string; tenantId: string };
export type Resource = { type: ScopeType; id: string };

export type CanInput = {
  subject: Subject;
  action: string;
  resource?: Resource;
  context?: Record<string, unknown>;
};

export type DenyReason =
  | "tenant_mismatch"
  | "resource_not_found"
  | "unknown_permission"
  | "invalid_resource"
  | "no_membership"
  | "no_grant"
  | "scope_not_covered"
  | "policy_denied"
  | "internal_error";

export type GrantSource = {
  via: "direct" | "team" | "legacy";
  roleId: string;
  roleName: string;
  teamId?: string;
  scopeType: string;
  scopeId: string;
  /** Présent pour un rôle d'équipe : périmètre dans lequel l'équipe reçoit ce rôle. */
  assignmentScope?: { scopeType: string; scopeId: string };
};

export type Decision = {
  allowed: boolean;
  reason: DenyReason | "granted";
  sources: GrantSource[];
};

export type ScopeRef = { scopeType: string; scopeId: string };
export type PermissionGrant = ScopeRef & { key: string };

export type RoleRecord = {
  id: string;
  tenantId: string;
  name: string;
  isSystem: boolean;
  permissions: PermissionGrant[];
};

export type MembershipRecord = {
  id: string;
  userId: string;
  tenantId: string;
  /** Chaîne historique de Membership.role, lue uniquement par le résolveur legacy. */
  legacyRole: string;
  roleId: string | null;
};

export type TeamRoleAssignment = ScopeRef & {
  teamId: string;
  role: RoleRecord;
};

export type ResourceRecord = {
  type: ScopeType;
  id: string;
  tenantId: string;
  /** Ancêtres connus de la ressource, par type (ex. un projet connaît son cluster). */
  parents: Partial<Record<ScopeType, string>>;
};

export interface GrantRepository {
  findMembership(
    userId: string,
    tenantId: string,
  ): Promise<MembershipRecord | null>;
  findRole(tenantId: string, roleId: string): Promise<RoleRecord | null>;
  findPresetRoleByName(
    tenantId: string,
    name: string,
  ): Promise<RoleRecord | null>;
  listTeamRoleAssignments(
    tenantId: string,
    membershipId: string,
  ): Promise<TeamRoleAssignment[]>;
}

export interface ResourceRepository {
  load(type: ScopeType, id: string): Promise<ResourceRecord | null>;
}

export interface PolicyEvaluator {
  evaluate(
    input: CanInput,
    sources: GrantSource[],
  ): Promise<"allow" | "deny" | "abstain">;
}

export class NoopPolicyEvaluator implements PolicyEvaluator {
  async evaluate(): Promise<"abstain"> {
    return "abstain";
  }
}

export type Catalog = ReadonlyMap<string, CatalogEntry>;

export type EngineDeps = {
  grants: GrantRepository;
  resources: ResourceRepository;
  policies: PolicyEvaluator;
  catalog: Catalog;
};
