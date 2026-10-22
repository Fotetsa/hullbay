import { isValidScopeType } from "../scope";
import { resolveGrants } from "./resolve-grants";
import { scopeCovers, type CoverageContext } from "./scope-covers";
import type {
  CanInput,
  Decision,
  DenyReason,
  EngineDeps,
  GrantSource,
  ResourceRecord,
} from "./types";

const deny = (reason: DenyReason, sources: GrantSource[] = []): Decision => ({
  allowed: false,
  reason,
  sources,
});

/**
 * Algorithme de décision. Toute exception interne devient un refus (fail closed),
 * jamais une autorisation.
 */
export async function decide(
  input: CanInput,
  deps: EngineDeps,
  onError?: (err: unknown) => void,
): Promise<Decision> {
  try {
    return await run(input, deps);
  } catch (err) {
    onError?.(err);
    return deny("internal_error");
  }
}

async function run(input: CanInput, deps: EngineDeps): Promise<Decision> {
  const { subject, action } = input;

  const entry = deps.catalog.get(action);
  if (!entry) return deny("unknown_permission");

  if (!subject?.userId || !subject?.tenantId) return deny("no_membership");
  const membership = await deps.grants.findMembership(
    subject.userId,
    subject.tenantId,
  );
  if (!membership || membership.tenantId !== subject.tenantId)
    return deny("no_membership");

  let resource: ResourceRecord | undefined;
  if (input.resource) {
    const { type, id } = input.resource;
    if (!isValidScopeType(type) || !entry.resourceTypes.includes(type))
      return deny("invalid_resource");
    const loaded = await deps.resources.load(type, id);
    if (!loaded) return deny("resource_not_found");
    if (loaded.tenantId !== subject.tenantId) return deny("tenant_mismatch");
    resource = loaded;
  }

  const accepted = new Set<string>([...entry.scopes, "tenant"]);
  const ctx: CoverageContext = {
    tenantId: subject.tenantId,
    resource,
    accepted,
  };

  const grants = await resolveGrants(deps.grants, membership);

  let permissionSeen = false;
  const sources: GrantSource[] = [];

  for (const grant of grants) {
    // Défense en profondeur : un rôle d'un autre tenant ne compte jamais.
    if (grant.role.tenantId !== subject.tenantId) continue;

    for (const p of grant.role.permissions) {
      if (p.key !== action) continue;
      permissionSeen = true;

      const permissionCovers = scopeCovers(p.scopeType, p.scopeId, ctx);
      // Pour un rôle d'équipe, le périmètre d'attribution restreint encore le rôle :
      // la ressource doit être couverte par les deux (intersection).
      const assignmentCovers = grant.restrictTo
        ? scopeCovers(grant.restrictTo.scopeType, grant.restrictTo.scopeId, ctx)
        : true;

      if (permissionCovers && assignmentCovers) {
        sources.push({
          via: grant.via,
          roleId: grant.role.id,
          roleName: grant.role.name,
          teamId: grant.teamId,
          scopeType: p.scopeType,
          scopeId: p.scopeId,
          assignmentScope: grant.restrictTo,
        });
      }
    }
  }

  if (sources.length === 0)
    return deny(permissionSeen ? "scope_not_covered" : "no_grant");

  // Point d'extension Phase 5 : un deny l'emporte. Un allow ne crée jamais de droit.
  const verdict = await deps.policies.evaluate(input, sources);
  if (verdict === "deny") return deny("policy_denied", sources);

  return { allowed: true, reason: "granted", sources };
}
