import { RESOURCE_CATALOG } from "./catalog/resource-catalog";
import { decide } from "./engine/decide";
import {
  NoopPolicyEvaluator,
  type CanInput,
  type Catalog,
  type Decision,
  type GrantRepository,
  type PolicyEvaluator,
  type ResourceRepository,
} from "./engine/types";
import { ForbiddenError } from "./errors";

export type AuthorizationDeps = {
  grants: GrantRepository;
  resources: ResourceRepository;
  policies?: PolicyEvaluator;
  catalog?: Catalog;
  /** Appelé sur une erreur interne, pour journaliser sans jamais autoriser. */
  onError?: (err: unknown) => void;
};

export type Authorization = {
  can(input: CanInput): Promise<Decision>;
  require(input: CanInput): Promise<Decision>;
};

export function createAuthorization(deps: AuthorizationDeps): Authorization {
  const engineDeps = {
    grants: deps.grants,
    resources: deps.resources,
    policies: deps.policies ?? new NoopPolicyEvaluator(),
    catalog: deps.catalog ?? RESOURCE_CATALOG,
  };

  const can = (input: CanInput) => decide(input, engineDeps, deps.onError);

  return {
    can,
    async require(input) {
      const decision = await can(input);
      if (!decision.allowed) throw new ForbiddenError(decision);
      return decision;
    },
  };
}
