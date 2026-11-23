import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import type { TenantScopedRequest } from "../../auth/tenancy/tenant-resolver";
import type { Subject } from "../engine/types";
import { requirePermission } from "../http";
import { subjectFromSession } from "../subject";
import { AdminError } from "./errors";
import { clearMembershipRole, setMembershipRole } from "./assignment.service";
import { effectivePermissions } from "./effective.service";
import {
  cloneRole,
  createRole,
  deleteRole,
  getRole,
  listCatalog,
  listRoles,
  setRolePermissions,
  updateRole,
} from "./role.service";
import {
  addTeamMember,
  assignTeamRole,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  revokeTeamRole,
  updateTeam,
} from "./team.service";
import { descriptionSchema, grantInputSchema, nameSchema } from "./validation";

const db = prisma as unknown as PrismaClient;

// TRANSITOIRE : seuil de la garde legacy, retiré avec le mode legacy en Phase 7.
const LEGACY_MIN = "owner" as const;
const guard = (action: string) => ({
  preHandler: requirePermission(action, { legacyMin: LEGACY_MIN }),
});

/** Le tenant vient UNIQUEMENT de la session ; un tenant de requête différent est refusé. */
function subjectOf(req: FastifyRequest): Subject {
  let subject: Subject;
  try {
    subject = subjectFromSession(
      (req as FastifyRequest & { user?: { sub: string; tenantId?: string } })
        .user,
    );
  } catch {
    throw new AdminError(401, "session_invalid", "session invalide");
  }
  const t = (req as TenantScopedRequest).tenantId;
  if (t && t !== subject.tenantId)
    throw new AdminError(403, "tenant_mismatch", "permission insuffisante");
  return subject;
}

const run =
  (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof AdminError) {
        return reply
          .code(e.status)
          .send({
            error: e.message,
            code: e.code,
            ...(e.details ? { details: e.details } : {}),
          });
      }
      throw e;
    }
  };

const id = z.object({ id: z.string().min(1).max(64) });
const tag = { tags: ["authorization"], security: [{ bearerAuth: [] }] };
const grants = z.array(grantInputSchema).max(200);

export async function registerAuthorizationAdminRoutes(app: FastifyInstance) {
  const P = "/api/authorization";

  // ── Rôles ──
  app.get(
    `${P}/permissions`,
    {
      ...guard("role.read"),
      schema: { ...tag, summary: "Catalogue des permissions" },
    },
    run(async () => listCatalog()),
  );
  app.get(
    `${P}/roles`,
    { ...guard("role.read"), schema: { ...tag, summary: "Lister les rôles" } },
    run(async (req) => listRoles(db, subjectOf(req).tenantId)),
  );
  app.get(
    `${P}/roles/:id`,
    {
      ...guard("role.read"),
      schema: { ...tag, params: id, summary: "Détail d'un rôle" },
    },
    run(async (req) =>
      getRole(db, subjectOf(req).tenantId, (req.params as { id: string }).id),
    ),
  );

  app.post(
    `${P}/roles`,
    {
      ...guard("role.create"),
      schema: {
        ...tag,
        summary: "Créer un rôle",
        body: z
          .object({
            name: nameSchema,
            description: descriptionSchema.optional(),
            permissions: grants.default([]),
          })
          .strict(),
      },
    },
    run(async (req, reply) => {
      const b = req.body as {
        name: string;
        description?: string;
        permissions: z.infer<typeof grants>;
      };
      return reply.code(201).send(await createRole(db, subjectOf(req), b));
    }),
  );

  app.post(
    `${P}/roles/:id/clone`,
    {
      ...guard("role.create"),
      schema: {
        ...tag,
        params: id,
        summary: "Cloner un rôle",
        body: z.object({ name: nameSchema }).strict(),
      },
    },
    run(async (req, reply) =>
      reply
        .code(201)
        .send(
          await cloneRole(
            db,
            subjectOf(req),
            (req.params as { id: string }).id,
            (req.body as { name: string }).name,
          ),
        ),
    ),
  );

  app.patch(
    `${P}/roles/:id`,
    {
      ...guard("role.update"),
      schema: {
        ...tag,
        params: id,
        summary: "Modifier nom / description",
        body: z
          .object({
            name: nameSchema.optional(),
            description: descriptionSchema.optional(),
          })
          .strict(),
      },
    },
    run(async (req) =>
      updateRole(
        db,
        subjectOf(req),
        (req.params as { id: string }).id,
        req.body as { name?: string; description?: string },
      ),
    ),
  );

  app.put(
    `${P}/roles/:id/permissions`,
    {
      ...guard("role.update"),
      schema: {
        ...tag,
        params: id,
        summary: "Remplacer les permissions d'un rôle",
        body: z.object({ permissions: grants }).strict(),
      },
    },
    run(async (req) =>
      setRolePermissions(
        db,
        subjectOf(req),
        (req.params as { id: string }).id,
        (req.body as { permissions: z.infer<typeof grants> }).permissions,
      ),
    ),
  );

  app.delete(
    `${P}/roles/:id`,
    {
      ...guard("role.delete"),
      schema: { ...tag, params: id, summary: "Supprimer un rôle" },
    },
    run(async (req, reply) => {
      await deleteRole(db, subjectOf(req), (req.params as { id: string }).id);
      return reply.code(204).send();
    }),
  );

  // ── Équipes ──
  app.get(
    `${P}/teams`,
    {
      ...guard("team.read"),
      schema: { ...tag, summary: "Lister les équipes" },
    },
    run(async (req) => listTeams(db, subjectOf(req).tenantId)),
  );
  app.get(
    `${P}/teams/:id`,
    {
      ...guard("team.read"),
      schema: { ...tag, params: id, summary: "Détail d'une équipe" },
    },
    run(async (req) =>
      getTeam(db, subjectOf(req).tenantId, (req.params as { id: string }).id),
    ),
  );

  app.post(
    `${P}/teams`,
    {
      ...guard("team.create"),
      schema: {
        ...tag,
        summary: "Créer une équipe",
        body: z
          .object({
            name: nameSchema,
            description: descriptionSchema.optional(),
          })
          .strict(),
      },
    },
    run(async (req, reply) =>
      reply
        .code(201)
        .send(
          await createTeam(
            db,
            subjectOf(req),
            req.body as { name: string; description?: string },
          ),
        ),
    ),
  );

  app.patch(
    `${P}/teams/:id`,
    {
      ...guard("team.update"),
      schema: {
        ...tag,
        params: id,
        summary: "Modifier une équipe",
        body: z
          .object({
            name: nameSchema.optional(),
            description: descriptionSchema.optional(),
          })
          .strict(),
      },
    },
    run(async (req) =>
      updateTeam(
        db,
        subjectOf(req),
        (req.params as { id: string }).id,
        req.body as { name?: string; description?: string },
      ),
    ),
  );

  app.delete(
    `${P}/teams/:id`,
    {
      ...guard("team.delete"),
      schema: { ...tag, params: id, summary: "Supprimer une équipe" },
    },
    run(async (req, reply) => {
      await deleteTeam(db, subjectOf(req), (req.params as { id: string }).id);
      return reply.code(204).send();
    }),
  );

  app.post(
    `${P}/teams/:id/members`,
    {
      ...guard("team.member.assign"),
      schema: {
        ...tag,
        params: id,
        summary: "Ajouter un membre",
        body: z.object({ membershipId: z.string().min(1).max(64) }).strict(),
      },
    },
    run(async (req, reply) => {
      await addTeamMember(
        db,
        subjectOf(req),
        (req.params as { id: string }).id,
        (req.body as { membershipId: string }).membershipId,
      );
      return reply.code(201).send({ ok: true });
    }),
  );

  app.delete(
    `${P}/teams/:id/members/:membershipId`,
    {
      ...guard("team.member.assign"),
      schema: {
        ...tag,
        params: id.extend({ membershipId: z.string().min(1).max(64) }),
        summary: "Retirer un membre",
      },
    },
    run(async (req, reply) => {
      const p = req.params as { id: string; membershipId: string };
      await removeTeamMember(db, subjectOf(req), p.id, p.membershipId);
      return reply.code(204).send();
    }),
  );

  app.post(
    `${P}/teams/:id/roles`,
    {
      ...guard("team.role.assign"),
      schema: {
        ...tag,
        params: id,
        summary: "Attribuer un rôle à l'équipe (avec scope)",
        body: z
          .object({
            roleId: z.string().min(1).max(64),
            scopeType: z.string().max(32).optional(),
            scopeId: z.string().max(64).optional(),
          })
          .strict(),
      },
    },
    run(async (req, reply) =>
      reply
        .code(201)
        .send(
          await assignTeamRole(
            db,
            subjectOf(req),
            (req.params as { id: string }).id,
            req.body as {
              roleId: string;
              scopeType?: string;
              scopeId?: string;
            },
          ),
        ),
    ),
  );

  app.delete(
    `${P}/teams/:id/roles/:assignmentId`,
    {
      ...guard("team.role.assign"),
      schema: {
        ...tag,
        params: id.extend({ assignmentId: z.string().min(1).max(64) }),
        summary: "Révoquer un rôle d'équipe",
      },
    },
    run(async (req, reply) => {
      const p = req.params as { id: string; assignmentId: string };
      await revokeTeamRole(db, subjectOf(req), p.id, p.assignmentId);
      return reply.code(204).send();
    }),
  );

  // ── Rôle direct ──
  app.put(
    `${P}/memberships/:id/role`,
    {
      ...guard("membership.role.assign"),
      schema: {
        ...tag,
        params: id,
        summary: "Attribuer le rôle direct d'une adhésion",
        body: z.object({ roleId: z.string().min(1).max(64) }).strict(),
      },
    },
    run(async (req) =>
      setMembershipRole(
        db,
        subjectOf(req),
        (req.params as { id: string }).id,
        (req.body as { roleId: string }).roleId,
      ),
    ),
  );

  app.delete(
    `${P}/memberships/:id/role`,
    {
      ...guard("membership.role.assign"),
      schema: {
        ...tag,
        params: id,
        summary: "Retirer le rôle direct (retour au rôle historique)",
      },
    },
    run(async (req) =>
      clearMembershipRole(
        db,
        subjectOf(req),
        (req.params as { id: string }).id,
      ),
    ),
  );

  // ── Permissions effectives ──
  app.get(
    `${P}/users/:id/effective-permissions`,
    {
      ...guard("authorization.read"),
      schema: {
        ...tag,
        params: id,
        summary: "Permissions effectives d'un utilisateur",
      },
    },
    run(async (req) => {
      const s = subjectOf(req);
      return effectivePermissions(
        db,
        s.tenantId,
        (req.params as { id: string }).id,
      );
    }),
  );

  // Ses propres permissions : authentification seule (la garde globale exige déjà session et MFA).
  app.get(
    `${P}/me/effective-permissions`,
    { schema: { ...tag, summary: "Mes permissions effectives" } },
    run(async (req) => {
      const s = subjectOf(req);
      return effectivePermissions(db, s.tenantId, s.userId);
    }),
  );
}
