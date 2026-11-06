import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { registryService } from "./service"
import { currentUser, type Role as LegacyRole } from "../auth/rbac";
import { requirePermission } from "../authorization/http";
import { eventBus } from "../../lib/event-bus"
import type { TenantScopedRequest } from "../auth/tenancy/tenant-resolver"

/**
 * Routes du registre - validation automatique via fastify-type-provider-zod
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */


// Gestion des credentials registre = OWNER uniquement (secret sensible).
const guard = (action: string, legacyMin: LegacyRole = "owner") => ({
  preHandler: requirePermission(action, { legacyMin }),
});

export async function registerRegistryRoutes(app: FastifyInstance) {
  app.get(
    "/api/registry",
    {
      ...guard("registry.read"),
      schema: {
        tags: ["registre"],
        summary: "Lister les credentials de registre (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => registryService.list((req as TenantScopedRequest).tenantId),
  );

  const setBody = z.object({
    registry: z.string().default("ghcr.io"),
    username: z.string().min(1),
    token: z.string().min(1),
  })
  app.post(
    "/api/registry",
    {
      ...guard("registry.set"),
      schema: {
        body: setBody,
        tags: ["registre"],
        summary:
          "Créer ou mettre à jour un credential de registre (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body as {
        registry: string;
        username: string;
        token: string;
      };
      const cred = await registryService.set(
        body.registry,
        body.username,
        body.token,
        (req as TenantScopedRequest).tenantId,
      );
      await eventBus.emit("registry.set", {
        userId: currentUser(req)?.sub,
        tenantId: (req as TenantScopedRequest).tenantId,
        registry: body.registry,
      });
      return { id: cred.id, registry: cred.registry, username: cred.username };
    },
  );

  app.delete(
    "/api/registry/:id",
    {
      ...guard("registry.delete"),
      schema: {
        tags: ["registre"],
        summary: "Supprimer un credential de registre (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      await registryService.remove(id, (req as TenantScopedRequest).tenantId);
      return { ok: true };
    },
  );
}
