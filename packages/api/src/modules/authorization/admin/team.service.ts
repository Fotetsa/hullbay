import type { PrismaClient } from "@prisma/client";
import { eventBus } from "../../../lib/event-bus";
import type { Subject } from "../engine/types";
import { AdminError, mapUnique, notFound, systemRole } from "./errors";
import {
  ROLE_PERMS_SELECT,
  assertHolds,
  grantsAtScope,
  withAdminGuard,
} from "./guards";
import { adminTx } from "./tx";
import { MAX_ASSIGNMENTS_PER_TEAM, sig, validateScope } from "./validation";

const nameTaken = (e: unknown) =>
  mapUnique(e, "name_taken", "une équipe porte déjà ce nom");

const TEAM_SELECT = {
  id: true,
  name: true,
  description: true,
  members: {
    select: {
      membershipId: true,
      membership: {
        select: { userId: true, user: { select: { email: true } } },
      },
    },
  },
  roles: {
    select: {
      id: true,
      roleId: true,
      scopeType: true,
      scopeId: true,
      role: { select: { name: true } },
    },
  },
} as const;

export async function listTeams(db: PrismaClient, tenantId: string) {
  const rows = await db.team.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      _count: { select: { members: true, roles: true } },
    },
  });
  return rows.map(({ _count, ...t }) => ({
    ...t,
    memberCount: _count.members,
    roleCount: _count.roles,
  }));
}

export async function getTeam(db: PrismaClient, tenantId: string, id: string) {
  const t = await db.team.findFirst({
    where: { id, tenantId },
    select: TEAM_SELECT,
  });
  if (!t) throw notFound();
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    members: t.members.map((m) => ({
      membershipId: m.membershipId,
      userId: m.membership.userId,
      email: m.membership.user.email,
    })),
    roles: t.roles.map((r) => ({
      assignmentId: r.id,
      roleId: r.roleId,
      roleName: r.role.name,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
    })),
  };
}

export async function createTeam(
  db: PrismaClient,
  subject: Subject,
  input: { name: string; description?: string },
) {
  let team;
  try {
    team = await db.team.create({
      data: {
        tenantId: subject.tenantId,
        name: input.name,
        description: input.description,
      },
      select: { id: true, name: true, description: true },
    });
  } catch (e) {
    throw nameTaken(e);
  }
  await eventBus.emit("team.created", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId: team.id,
    name: team.name,
  });
  return team;
}

export async function updateTeam(
  db: PrismaClient,
  subject: Subject,
  id: string,
  input: { name?: string; description?: string },
) {
  const found = await db.team.findFirst({
    where: { id, tenantId: subject.tenantId },
    select: { id: true },
  });
  if (!found) throw notFound();
  let team;
  try {
    team = await db.team.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      },
      select: { id: true, name: true, description: true },
    });
  } catch (e) {
    throw nameTaken(e);
  }
  await eventBus.emit("team.updated", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId: id,
  });
  return team;
}

export async function deleteTeam(
  db: PrismaClient,
  subject: Subject,
  id: string,
) {
  await adminTx(db, subject.tenantId, async (tx) => {
    const t = await tx.team.findFirst({
      where: { id, tenantId: subject.tenantId },
      select: { id: true },
    });
    if (!t) throw notFound();
    await withAdminGuard(tx, subject.tenantId, () =>
      tx.team.delete({ where: { id } }),
    );
  });
  await eventBus.emit("team.deleted", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId: id,
  });
}

/** Ajouter un membre lui confère les droits de l'équipe : l'acteur doit les posséder. */
export async function addTeamMember(
  db: PrismaClient,
  subject: Subject,
  teamId: string,
  membershipId: string,
) {
  await adminTx(db, subject.tenantId, async (tx) => {
    const team = await tx.team.findFirst({
      where: { id: teamId, tenantId: subject.tenantId },
      select: {
        id: true,
        roles: {
          select: {
            scopeType: true,
            scopeId: true,
            role: { select: ROLE_PERMS_SELECT },
          },
        },
      },
    });
    if (!team) throw notFound();
    const m = await tx.membership.findFirst({
      where: { id: membershipId, tenantId: subject.tenantId },
      select: { id: true },
    });
    if (!m) throw notFound();
    const grants = new Map<string, ReturnType<typeof grantsAtScope>[number]>();
    for (const a of team.roles)
      for (const g of grantsAtScope(a.role, a)) grants.set(sig(g), g);
    await assertHolds(tx, subject, [...grants.values()]);
    try {
      await tx.teamMember.create({
        data: { tenantId: subject.tenantId, teamId, membershipId },
      });
    } catch (e) {
      throw mapUnique(
        e,
        "already_member",
        "cette adhésion est déjà membre de l'équipe",
      );
    }
  });
  await eventBus.emit("team.member.added", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId,
    membershipId,
  });
}

export async function removeTeamMember(
  db: PrismaClient,
  subject: Subject,
  teamId: string,
  membershipId: string,
) {
  await adminTx(db, subject.tenantId, async (tx) => {
    const tm = await tx.teamMember.findFirst({
      where: { tenantId: subject.tenantId, teamId, membershipId },
      select: { id: true },
    });
    if (!tm) throw notFound();
    await withAdminGuard(tx, subject.tenantId, () =>
      tx.teamMember.delete({ where: { id: tm.id } }),
    );
  });
  await eventBus.emit("team.member.removed", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId,
    membershipId,
  });
}

export async function assignTeamRole(
  db: PrismaClient,
  subject: Subject,
  teamId: string,
  input: { roleId: string; scopeType?: string; scopeId?: string },
) {
  const row = await adminTx(db, subject.tenantId, async (tx) => {
    const team = await tx.team.findFirst({
      where: { id: teamId, tenantId: subject.tenantId },
      select: { id: true },
    });
    if (!team) throw notFound();
    const role = await tx.role.findFirst({
      where: { id: input.roleId, tenantId: subject.tenantId },
      select: ROLE_PERMS_SELECT,
    });
    if (!role) throw notFound();
    if (role.isSystem) throw systemRole();
    const scope = await validateScope(
      tx,
      subject.tenantId,
      input.scopeType,
      input.scopeId,
    );
    if (
      (await tx.teamRole.count({
        where: { tenantId: subject.tenantId, teamId },
      })) >= MAX_ASSIGNMENTS_PER_TEAM
    ) {
      throw new AdminError(
        400,
        "too_many_assignments",
        `maximum ${MAX_ASSIGNMENTS_PER_TEAM} attributions par équipe`,
      );
    }
    await assertHolds(tx, subject, grantsAtScope(role, scope));
    try {
      return await tx.teamRole.create({
        data: {
          tenantId: subject.tenantId,
          teamId,
          roleId: role.id,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
        },
        select: { id: true, roleId: true, scopeType: true, scopeId: true },
      });
    } catch (e) {
      throw mapUnique(
        e,
        "already_assigned",
        "ce rôle est déjà attribué à cette équipe sur ce périmètre",
      );
    }
  });
  await eventBus.emit("team.role.assigned", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId,
    roleId: row.roleId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
  });
  return {
    assignmentId: row.id,
    roleId: row.roleId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
  };
}

export async function revokeTeamRole(
  db: PrismaClient,
  subject: Subject,
  teamId: string,
  assignmentId: string,
) {
  await adminTx(db, subject.tenantId, async (tx) => {
    const a = await tx.teamRole.findFirst({
      where: { id: assignmentId, teamId, tenantId: subject.tenantId },
      select: { id: true },
    });
    if (!a) throw notFound();
    await withAdminGuard(tx, subject.tenantId, () =>
      tx.teamRole.delete({ where: { id: a.id } }),
    );
  });
  await eventBus.emit("team.role.revoked", {
    userId: subject.userId,
    tenantId: subject.tenantId,
    teamId,
    assignmentId,
  });
}
