import type { PrismaClient } from "@prisma/client";
import type {
  GrantRepository,
  ResourceRecord,
  ResourceRepository,
  RoleRecord,
  TeamRoleAssignment,
} from "../engine/types";
import type { ScopeType } from "../scope";

const ROLE_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  isSystem: true,
  rolePermissions: {
    select: {
      scopeType: true,
      scopeId: true,
      permission: { select: { key: true } },
    },
  },
} as const;

type RoleRow = {
  id: string;
  tenantId: string;
  name: string;
  isSystem: boolean;
  rolePermissions: {
    scopeType: string;
    scopeId: string;
    permission: { key: string };
  }[];
};

function toRole(row: RoleRow): RoleRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    isSystem: row.isSystem,
    permissions: row.rolePermissions.map((rp) => ({
      key: rp.permission.key,
      scopeType: rp.scopeType,
      scopeId: rp.scopeId,
    })),
  };
}

export class PrismaGrantRepository implements GrantRepository {
  constructor(private prisma: PrismaClient) {}

  async findMembership(userId: string, tenantId: string) {
    const m = await this.prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        role: true,
        roleId: true,
      },
    });
    return m
      ? {
          id: m.id,
          userId: m.userId,
          tenantId: m.tenantId,
          legacyRole: m.role,
          roleId: m.roleId,
        }
      : null;
  }

  async findRole(tenantId: string, roleId: string) {
    const row = await this.prisma.role.findFirst({
      where: { id: roleId, tenantId },
      select: ROLE_SELECT,
    });
    return row ? toRole(row) : null;
  }

  async findPresetRoleByName(tenantId: string, name: string) {
    const row = await this.prisma.role.findFirst({
      where: { tenantId, name, isPreset: true },
      select: ROLE_SELECT,
    });
    return row ? toRole(row) : null;
  }

  async listTeamRoleAssignments(
    tenantId: string,
    membershipId: string,
  ): Promise<TeamRoleAssignment[]> {
    const rows = await this.prisma.teamRole.findMany({
      where: { tenantId, team: { members: { some: { membershipId } } } },
      select: {
        teamId: true,
        scopeType: true,
        scopeId: true,
        role: { select: ROLE_SELECT },
      },
    });
    return rows.map((r) => ({
      teamId: r.teamId,
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      role: toRole(r.role),
    }));
  }
}

/** Charge une ressource avec son tenant propriétaire et ses ancêtres (chemin déterministe, V3 §28). */
export class PrismaResourceRepository implements ResourceRepository {
  constructor(private prisma: PrismaClient) {}

  async load(type: ScopeType, id: string): Promise<ResourceRecord | null> {
    switch (type) {
      case "tenant": {
        const t = await this.prisma.tenant.findUnique({
          where: { id },
          select: { id: true },
        });
        return t ? { type, id, tenantId: t.id, parents: {} } : null;
      }
      case "cluster": {
        const c = await this.prisma.cluster.findUnique({
          where: { id },
          select: { tenantId: true },
        });
        return c ? { type, id, tenantId: c.tenantId, parents: {} } : null;
      }
      case "server": {
        const s = await this.prisma.server.findUnique({
          where: { id },
          select: { tenantId: true, clusterId: true },
        });
        return s
          ? {
              type,
              id,
              tenantId: s.tenantId,
              parents: { cluster: s.clusterId },
            }
          : null;
      }
      case "project": {
        const p = await this.prisma.project.findUnique({
          where: { id },
          select: { tenantId: true, clusterId: true },
        });
        return p
          ? {
              type,
              id,
              tenantId: p.tenantId,
              parents: { cluster: p.clusterId },
            }
          : null;
      }
      case "node": {
        const n = await this.prisma.node.findUnique({
          where: { id },
          select: {
            projectId: true,
            project: { select: { tenantId: true, clusterId: true } },
          },
        });
        return n
          ? {
              type,
              id,
              tenantId: n.project.tenantId,
              parents: { project: n.projectId, cluster: n.project.clusterId },
            }
          : null;
      }
      case "edge": {
        const e = await this.prisma.edge.findUnique({
          where: { id },
          select: {
            projectId: true,
            project: { select: { tenantId: true, clusterId: true } },
          },
        });
        return e
          ? {
              type,
              id,
              tenantId: e.project.tenantId,
              parents: { project: e.projectId, cluster: e.project.clusterId },
            }
          : null;
      }
    }
  }
}
