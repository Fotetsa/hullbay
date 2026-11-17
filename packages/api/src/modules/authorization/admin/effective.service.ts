import type { PrismaClient } from "@prisma/client";
import { explain } from "../engine/explain";
import { PrismaGrantRepository } from "../repositories/prisma";
import { notFound } from "./errors";

export async function effectivePermissions(
  db: PrismaClient,
  tenantId: string,
  userId: string,
) {
  const repo = new PrismaGrantRepository(db);
  const membership = await repo.findMembership(userId, tenantId);
  if (!membership) throw notFound();
  const rights = await explain(repo, membership);

  const teamIds = [
    ...new Set(rights.map((r) => r.teamId).filter((x): x is string => !!x)),
  ];
  const teams = teamIds.length
    ? await db.team.findMany({
        where: { id: { in: teamIds }, tenantId },
        select: { id: true, name: true },
      })
    : [];
  const teamName = new Map(teams.map((t) => [t.id, t.name]));

  const byKey = new Map<
    string,
    Map<string, { scopeType: string; scopeId: string; sources: unknown[] }>
  >();
  for (const r of rights) {
    const scopes = byKey.get(r.key) ?? new Map();
    const sk = `${r.scopeType}|${r.scopeId}`;
    const entry = scopes.get(sk) ?? {
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      sources: [],
    };
    entry.sources.push({
      via: r.via,
      roleId: r.roleId,
      roleName: r.roleName,
      teamId: r.teamId ?? null,
      teamName: r.teamId ? (teamName.get(r.teamId) ?? null) : null,
      assignmentScope: r.assignmentScope ?? null,
    });
    scopes.set(sk, entry);
    byKey.set(r.key, scopes);
  }

  return {
    userId,
    tenantId,
    legacyRole: membership.legacyRole,
    directRoleId: membership.roleId,
    permissions: [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, scopes]) => ({ key, grants: [...scopes.values()] })),
  };
}
