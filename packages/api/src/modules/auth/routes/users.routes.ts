/**
 * Routes de gestion des utilisateurs (owner uniquement) — extraites de routes.ts.
 * Opérations auditées via eventBus (user.created / user.role.changed / user.deleted).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import { currentUser, type Role as LegacyRole } from "../authorization/rbac";
import { requirePermission } from "../../authorization/http";
import { eventBus } from "../../../lib/event-bus"
import { authService } from "../service"
import type { TenantScopedRequest } from "../tenancy/tenant-resolver"
import { DEFAULT_TENANT_ID } from "../identity/auth-identity.service"

const guard = (action: string, legacyMin: LegacyRole = "owner") => ({
  preHandler: requirePermission(action, { legacyMin }),
});

function reqTenant(req: FastifyRequest): string {
  // Tenant effectif posé par la garde (header validé par membership) ;
  // repli par défaut pour les harnais de test sans garde.
  return (req as TenantScopedRequest).tenantId ?? DEFAULT_TENANT_ID
}

export async function registerUsersRoutes(app: FastifyInstance) {
  app.get(
    "/api/users",
    {
      ...guard("user.read"),
      schema: {
        tags: ["auth"],
        summary: "Liste des utilisateurs (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => authService.listUsers(reqTenant(req)),
  );

  const createUserBody = z.object({
    email: z.string().email(),
    password: z.string().min(8, "8 caractères minimum"),
    role: z.enum(["operator", "viewer"]),
  })

  app.post(
    "/api/users",
    {
      ...guard("user.create"),
      schema: {
        body: createUserBody,
        tags: ["auth"],
        summary: "Création d'un utilisateur (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      try {
        const body = createUserBody.parse(req.body);
        const u = await authService.createUser(
          body.email,
          body.password,
          body.role,
          reqTenant(req),
        );
        await eventBus.emit("user.created", {
          userId: currentUser(req)?.sub,
          targetUserId: u.id,
          email: u.email,
          role: u.role,
          // C9 : les auditeurs tenant-aware doivent pouvoir corréler l'événement.
          tenantId: reqTenant(req),
        });
        return u;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  const setRoleBody = z.object({
    role: z.enum(["owner", "operator", "viewer"]),
  })

  app.post(
    "/api/users/:id/role",
    {
      ...guard("user.update"),
      schema: {
        body: setRoleBody,
        tags: ["auth"],
        summary:
          "Changement de rôle d'un utilisateur (owner uniquement) — audité",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const body = setRoleBody.parse(req.body);
        const u = await authService.setRole(id, body.role, reqTenant(req));
        await eventBus.emit("user.role.changed", {
          userId: currentUser(req)?.sub,
          targetUserId: id,
          role: u.role,
          tenantId: reqTenant(req),
        });
        return u;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/users/:id",
    {
      ...guard("user.delete"),
      schema: {
        tags: ["auth"],
        summary: "Suppression d'un utilisateur (owner uniquement) — audité",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const acting = currentUser(req)?.sub;
      if (!acting) return reply.code(401).send({ error: "non authentifié" });
      try {
        const r = await authService.deleteUser(id, acting, reqTenant(req));
        await eventBus.emit("user.deleted", {
          userId: acting,
          targetUserId: id,
          tenantId: reqTenant(req),
        });
        return r;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
