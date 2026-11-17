import { resolveGrants } from "./resolve-grants";
import { scopeCovers, type CoverageContext } from "./scope-covers";
import type {
  Catalog,
  GrantRepository,
  MembershipRecord,
  ResourceRecord,
  ScopeRef,
} from "./types";

export type ExplainedRight = {
  key: string;
  scopeType: string;
  scopeId: string;
  via: "direct" | "team" | "legacy";
  roleId: string;
  roleName: string;
  teamId?: string;
  assignmentScope?: ScopeRef;
};

/** Tous les droits d'une adhésion, avec leur provenance. Même résolution que decide(). */
export async function explain(
  repo: GrantRepository,
  membership: MembershipRecord,
): Promise<ExplainedRight[]> {
  const grants = await resolveGrants(repo, membership);
  const out: ExplainedRight[] = [];
  for (const g of grants) {
    if (g.role.tenantId !== membership.tenantId) continue;
    for (const p of g.role.permissions) {
      out.push({
        key: p.key,
        scopeType: p.scopeType,
        scopeId: p.scopeId,
        via: g.via,
        roleId: g.role.id,
        roleName: g.role.name,
        teamId: g.teamId,
        assignmentScope: g.restrictTo,
      });
    }
  }
  return out;
}

/** Un droit couvre-t-il la cible ? Intersection permission / attribution comprise. */
export function rightCovers(
  right: ExplainedRight,
  ctx: CoverageContext,
): boolean {
  if (!scopeCovers(right.scopeType, right.scopeId, ctx)) return false;
  return right.assignmentScope
    ? scopeCovers(
        right.assignmentScope.scopeType,
        right.assignmentScope.scopeId,
        ctx,
      )
    : true;
}

/**
 * L'acteur possède-t-il ce couple permission + scope ? Sert à l'anti-escalade.
 * `record` est la ressource désignée par le scope cible (absente pour le scope tenant).
 */
export function holds(
  rights: ExplainedRight[],
  key: string,
  target: { scopeType: string; scopeId: string; record?: ResourceRecord },
  tenantId: string,
  catalog: Catalog,
): boolean {
  const entry = catalog.get(key);
  if (!entry) return false;
  const ctx: CoverageContext = {
    tenantId,
    resource: target.scopeType === "tenant" ? undefined : target.record,
    accepted: new Set<string>([...entry.scopes, "tenant"]),
  };
  if (target.scopeType !== "tenant" && !ctx.resource) return false;
  return rights.some((r) => r.key === key && rightCovers(r, ctx));
}
