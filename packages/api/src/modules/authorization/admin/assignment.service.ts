import type { PrismaClient } from "@prisma/client";
import { eventBus } from "../../../lib/event-bus";
import type { Subject } from "../engine/types";
import { notFound, systemRole } from "./errors";
import {
  ROLE_PERMS_SELECT,
  assertHolds,
  roleGrants,
  withAdminGuard,
} from "./guards";
import { adminTx } from "./tx";

export async function setMembershipRole(
  db: PrismaClient,
  subject: Subject,
  membershipId: string,
  roleId: string,
) {
  const out = await adminTx(db, subject.tenantId, async (tx) => {
    const m = await tx.membership.findFirst({
      where: { id: membershipId, tenantId: subject.tenantId },
      select: { id: true, role: true, roleId: true },
    });
    if (!m) throw notFound();
    const role = await tx.role.findFirst({
      where: { id: roleId, tenantId: subject.tenantId },
      select: ROLE_PERMS_SELECT,
    });
    if (!role) throw notFound();
    if (role.isSystem) throw systemRole();
    await assertHolds(tx, subject, roleGrants(role));
    await withAdminGuard(tx, subject.tenantId, () =>
      tx.membership.update({ where: { id: m.id }, data: { roleId } }),
    );
    return {
      membershipId: m.id,
      roleId: role.id,
      roleName: role.name,
      legacyRole: m.role,
      diverges: m.role.trim().toLowerCase() !== role.name.trim().toLowerCase(),
    };
  });
  await eventBus.emit("membership.role.assigned", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    membershipId,
    roleId,
    legacyRole: out.legacyRole,
    diverges: out.diverges,
  });
  return out;
}

/** Retirer le rôle direct : l'adhésion retombe sur la chaîne legacy (jusqu'à la Phase 7). */
export async function clearMembershipRole(
  db: PrismaClient,
  subject: Subject,
  membershipId: string,
) {
  const legacyRole = await adminTx(db, subject.tenantId, async (tx) => {
    const m = await tx.membership.findFirst({
      where: { id: membershipId, tenantId: subject.tenantId },
      select: { id: true, role: true },
    });
    if (!m) throw notFound();
    await withAdminGuard(tx, subject.tenantId, () =>
      tx.membership.update({ where: { id: m.id }, data: { roleId: null } }),
    );
    return m.role;
  });
  await eventBus.emit("membership.role.revoked", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    membershipId,
  });
  return { membershipId, roleId: null, legacyRole };
}
