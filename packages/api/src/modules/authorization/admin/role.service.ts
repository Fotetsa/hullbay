import type { PrismaClient } from "@prisma/client";
import { eventBus } from "../../../lib/event-bus";
import { RESOURCE_CATALOG } from "../catalog/resource-catalog";
import type { Subject } from "../engine/types";
import { AdminError, mapUnique, notFound, systemRole } from "./errors";
import {
  ROLE_PERMS_SELECT,
  assertHolds,
  legacyPresetInUse,
  roleGrants,
  withAdminGuard,
  type RoleWithPerms,
} from "./guards";
import { adminTx } from "./tx";
import {
  permissionIds,
  sig,
  validateGrants,
  type GrantInput,
} from "./validation";

const toDto = (r: RoleWithPerms) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  isSystem: r.isSystem,
  isPreset: r.isPreset,
  permissions: r.rolePermissions.map((rp) => ({
    permission: rp.permission.key,
    scopeType: rp.scopeType,
    scopeId: rp.scopeId,
  })),
});

const nameTaken = (e: unknown) =>
  mapUnique(e, "name_taken", "un rôle porte déjà ce nom");
const rowsFor = (
  grants: ReturnType<typeof roleGrants>,
  ids: Map<string, string>,
  roleId: string,
) =>
  grants.map((g) => ({
    roleId,
    permissionId: ids.get(g.key)!,
    scopeType: g.scopeType,
    scopeId: g.scopeId,
  }));

export function listCatalog() {
  return [...RESOURCE_CATALOG.entries()].map(([key, e]) => ({
    key,
    resourceTypes: e.resourceTypes,
    scopes: [...new Set(["tenant", ...e.scopes])],
  }));
}

export async function listRoles(db: PrismaClient, tenantId: string) {
  const rows = await db.role.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      isSystem: true,
      isPreset: true,
      _count: {
        select: { rolePermissions: true, memberships: true, teamRoles: true },
      },
    },
  });
  return rows.map(({ _count, ...r }) => ({
    ...r,
    permissionCount: _count.rolePermissions,
    memberCount: _count.memberships,
    teamCount: _count.teamRoles,
  }));
}

export async function getRole(db: PrismaClient, tenantId: string, id: string) {
  const r = await db.role.findFirst({
    where: { id, tenantId },
    select: ROLE_PERMS_SELECT,
  });
  if (!r) throw notFound();
  return toDto(r);
}

export async function createRole(
  db: PrismaClient,
  subject: Subject,
  input: { name: string; description?: string; permissions: GrantInput[] },
) {
  const role = await adminTx(db, subject.tenantId, async (tx) => {
    const grants = await validateGrants(
      tx,
      subject.tenantId,
      input.permissions,
    );
    await assertHolds(tx, subject, grants);
    const ids = await permissionIds(tx, grants);
    try {
      return await tx.role.create({
        data: {
          tenantId: subject.tenantId,
          name: input.name,
          description: input.description,
          isPreset: false,
          isSystem: false,
          rolePermissions: {
            create: grants.map((g) => ({
              permissionId: ids.get(g.key)!,
              scopeType: g.scopeType,
              scopeId: g.scopeId,
            })),
          },
        },
        select: ROLE_PERMS_SELECT,
      });
    } catch (e) {
      throw nameTaken(e);
    }
  });
  await eventBus.emit("role.created", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    roleId: role.id,
    name: role.name,
  });
  return toDto(role);
}

export async function cloneRole(
  db: PrismaClient,
  subject: Subject,
  id: string,
  name: string,
) {
  const role = await adminTx(db, subject.tenantId, async (tx) => {
    const src = await tx.role.findFirst({
      where: { id, tenantId: subject.tenantId },
      select: ROLE_PERMS_SELECT,
    });
    if (!src) throw notFound();
    if (src.isSystem) throw systemRole();
    const grants = roleGrants(src);
    await assertHolds(tx, subject, grants);
    const ids = await permissionIds(tx, grants);
    try {
      return await tx.role.create({
        data: {
          tenantId: subject.tenantId,
          name,
          description: src.description,
          isPreset: false,
          isSystem: false,
          rolePermissions: {
            create: grants.map((g) => ({
              permissionId: ids.get(g.key)!,
              scopeType: g.scopeType,
              scopeId: g.scopeId,
            })),
          },
        },
        select: ROLE_PERMS_SELECT,
      });
    } catch (e) {
      throw nameTaken(e);
    }
  });
  await eventBus.emit("role.cloned", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    roleId: role.id,
    sourceRoleId: id,
    name,
  });
  return toDto(role);
}

export async function updateRole(
  db: PrismaClient,
  subject: Subject,
  id: string,
  input: { name?: string; description?: string },
) {
  const role = await adminTx(db, subject.tenantId, async (tx) => {
    const cur = await tx.role.findFirst({
      where: { id, tenantId: subject.tenantId },
      select: ROLE_PERMS_SELECT,
    });
    if (!cur) throw notFound();
    if (cur.isSystem) throw systemRole();
    if (
      input.name !== undefined &&
      input.name !== cur.name &&
      cur.isPreset &&
      (await legacyPresetInUse(tx, subject.tenantId))
    ) {
      throw new AdminError(
        409,
        "preset_in_legacy_use",
        "ce preset est encore utilisé par des adhésions sans rôle direct",
      );
    }
    try {
      return await tx.role.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
        },
        select: ROLE_PERMS_SELECT,
      });
    } catch (e) {
      throw nameTaken(e);
    }
  });
  await eventBus.emit("role.updated", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    roleId: id,
  });
  return toDto(role);
}

/** Remplacement complet. Seuls les droits AJOUTÉS doivent être possédés par l'acteur. */
export async function setRolePermissions(
  db: PrismaClient,
  subject: Subject,
  id: string,
  inputs: GrantInput[],
) {
  const result = await adminTx(db, subject.tenantId, async (tx) => {
    const cur = await tx.role.findFirst({
      where: { id, tenantId: subject.tenantId },
      select: ROLE_PERMS_SELECT,
    });
    if (!cur) throw notFound();
    if (cur.isSystem) throw systemRole();
    const grants = await validateGrants(tx, subject.tenantId, inputs);
    const had = new Set(roleGrants(cur).map(sig));
    await assertHolds(
      tx,
      subject,
      grants.filter((g) => !had.has(sig(g))),
    );
    const ids = await permissionIds(tx, grants);
    await withAdminGuard(tx, subject.tenantId, async () => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (grants.length)
        await tx.rolePermission.createMany({ data: rowsFor(grants, ids, id) });
    });
    return tx.role.findFirstOrThrow({
      where: { id },
      select: ROLE_PERMS_SELECT,
    });
  });
  await eventBus.emit("role.updated", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    roleId: id,
    permissionCount: inputs.length,
  });
  return toDto(result);
}

export async function deleteRole(
  db: PrismaClient,
  subject: Subject,
  id: string,
) {
  await adminTx(db, subject.tenantId, async (tx) => {
    const cur = await tx.role.findFirst({
      where: { id, tenantId: subject.tenantId },
      select: ROLE_PERMS_SELECT,
    });
    if (!cur) throw notFound();
    if (cur.isSystem) throw systemRole();
    if (cur.isPreset && (await legacyPresetInUse(tx, subject.tenantId))) {
      throw new AdminError(
        409,
        "preset_in_legacy_use",
        "ce preset est encore utilisé par des adhésions sans rôle direct",
      );
    }
    const memberships = await tx.membership.count({
      where: { tenantId: subject.tenantId, roleId: id },
    });
    const teams = await tx.teamRole.count({
      where: { tenantId: subject.tenantId, roleId: id },
    });
    if (memberships + teams > 0) {
      throw new AdminError(409, "role_in_use", "le rôle est encore attribué", {
        memberships,
        teams,
      });
    }
    await withAdminGuard(tx, subject.tenantId, () =>
      tx.role.delete({ where: { id } }),
    );
  });
  await eventBus.emit("role.deleted", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    roleId: id,
  });
}
