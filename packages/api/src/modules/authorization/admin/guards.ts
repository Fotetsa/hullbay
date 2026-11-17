import type { Prisma, PrismaClient } from "@prisma/client";
import { RESOURCE_CATALOG } from "../catalog/resource-catalog";
import { explain, holds, type ExplainedRight } from "../engine/explain";
import type { Subject } from "../engine/types";
import {
  PrismaGrantRepository,
  PrismaResourceRepository,
} from "../repositories/prisma";
import type { ScopeType } from "../scope";
import { AdminError } from "./errors";
import { sig, type Grant } from "./validation";

type Tx = Prisma.TransactionClient;
const asClient = (tx: Tx) => tx as unknown as PrismaClient;

export const ROLE_PERMS_SELECT = {
  id: true,
  name: true,
  isSystem: true,
  isPreset: true,
  description: true,
  rolePermissions: {
    select: {
      scopeType: true,
      scopeId: true,
      permission: { select: { key: true } },
    },
  },
} as const;

export type RoleWithPerms = {
  id: string;
  name: string;
  isSystem: boolean;
  isPreset: boolean;
  description: string | null;
  rolePermissions: {
    scopeType: string;
    scopeId: string;
    permission: { key: string };
  }[];
};

/** Droits d'un rôle tels qu'ils sont stockés. */
export function roleGrants(role: RoleWithPerms): Grant[] {
  return role.rolePermissions.map((rp) => ({
    key: rp.permission.key,
    scopeType: rp.scopeType,
    scopeId: rp.scopeId,
  }));
}

/**
 * Droits qu'un rôle confère quand il est attribué à un périmètre. Estimation conservative
 * (on retient le périmètre d'attribution) ; les permissions qui n'acceptent pas ce type de
 * scope sont inertes et ignorées.
 */
export function grantsAtScope(
  role: RoleWithPerms,
  scope: { scopeType: string; scopeId: string },
): Grant[] {
  const out = new Map<string, Grant>();
  for (const rp of role.rolePermissions) {
    const entry = RESOURCE_CATALOG.get(rp.permission.key);
    if (!entry) continue;
    const accepted = new Set<string>([...entry.scopes, "tenant"]);
    if (!accepted.has(scope.scopeType)) continue;
    const g = { key: rp.permission.key, ...scope };
    out.set(sig(g), g);
  }
  return [...out.values()];
}

async function rightsOf(
  tx: Tx,
  userId: string,
  tenantId: string,
): Promise<ExplainedRight[] | null> {
  const repo = new PrismaGrantRepository(asClient(tx));
  const m = await repo.findMembership(userId, tenantId);
  return m ? explain(repo, m) : null;
}

/** Anti-escalade : l'acteur doit posséder chaque droit accordé, dans un périmètre au moins aussi large. */
export async function assertHolds(
  tx: Tx,
  subject: Subject,
  grants: Grant[],
): Promise<void> {
  if (grants.length === 0) return;
  const rights = await rightsOf(tx, subject.userId, subject.tenantId);
  if (!rights)
    throw new AdminError(403, "no_membership", "permission insuffisante");
  const resources = new PrismaResourceRepository(asClient(tx));
  for (const g of grants) {
    const record =
      g.scopeType === "tenant"
        ? undefined
        : ((await resources.load(g.scopeType as ScopeType, g.scopeId)) ??
          undefined);
    if (
      !holds(
        rights,
        g.key,
        { scopeType: g.scopeType, scopeId: g.scopeId, record },
        subject.tenantId,
        RESOURCE_CATALOG,
      )
    ) {
      throw new AdminError(
        403,
        "cannot_grant_unowned",
        "on ne peut accorder que des droits que l'on possède",
      );
    }
  }
}

/** Nombre d'administrateurs : adhésions avec role.update ET membership.role.assign au scope tenant. */
export async function countAdmins(tx: Tx, tenantId: string): Promise<number> {
  const repo = new PrismaGrantRepository(asClient(tx));
  const members = await tx.membership.findMany({
    where: { tenantId },
    select: {
      id: true,
      userId: true,
      tenantId: true,
      role: true,
      roleId: true,
    },
  });
  let n = 0;
  for (const m of members) {
    const rights = await explain(repo, {
      id: m.id,
      userId: m.userId,
      tenantId: m.tenantId,
      legacyRole: m.role,
      roleId: m.roleId,
    });
    const has = (key: string) =>
      holds(
        rights,
        key,
        { scopeType: "tenant", scopeId: tenantId },
        tenantId,
        RESOURCE_CATALOG,
      );
    if (has("role.update") && has("membership.role.assign")) n += 1;
  }
  return n;
}

/**
 * Anti-verrouillage : une mutation ne peut pas faire passer le nombre d'administrateurs
 * de >0 à 0. Évalué dans la transaction (sous verrou) : le refus annule la mutation.
 */
export async function withAdminGuard<T>(
  tx: Tx,
  tenantId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const before = await countAdmins(tx, tenantId);
  const result = await mutate();
  if (before > 0 && (await countAdmins(tx, tenantId)) === 0) {
    throw new AdminError(
      409,
      "would_lock_out_tenant",
      "l'opération supprimerait le dernier administrateur des rôles",
    );
  }
  return result;
}

/** Le repli legacy résout les presets par nom tant qu'une adhésion n'a pas de rôle direct. */
export async function legacyPresetInUse(
  tx: Tx,
  tenantId: string,
): Promise<boolean> {
  return (await tx.membership.count({ where: { tenantId, roleId: null } })) > 0;
}
