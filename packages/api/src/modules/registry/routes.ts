import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { registryService } from "./service"
import { requireRole, currentUser } from "../auth/rbac"
import { eventBus } from "../../lib/event-bus"

/**
 * Routes du registre - validation automatique via fastify-type-provider-zod
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */


// Gestion des credentials registre = OWNER uniquement (secret sensible).
const owner = { preHandler: requireRole("owner") }

export async function registerRegistryRoutes(app: FastifyInstance) {
  app.get(
    "/api/registry",
    {
      ...owner,
      schema: {
        tags: ["registre"],
        summary: "Lister les credentials de registre (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => registryService.list(),
  );

  const setBody = z.object({
    registry: z.string().default("ghcr.io"),
    username: z.string().min(1),
    token: z.string().min(1),
  })
  app.post(
    "/api/registry",
    {
      ...owner,
      schema: {
        body: setBody,
        tags: ["registre"],
        summary:
          "Créer ou mettre à jour un credential de registre (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body as { registry: string; username: string; token: string };
      const cred = await registryService.set(
        body.registry,
        body.username,
        body.token,
      );
      await eventBus.emit("registry.set", {
        userId: currentUser(req)?.sub,
        registry: body.registry,
      });
      return { id: cred.id, registry: cred.registry, username: cred.username };
    },
  );

  app.delete(
    "/api/registry/:id",
    {
      ...owner,
      schema: {
        tags: ["registre"],
        summary: "Supprimer un credential de registre (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      await registryService.remove(id);
      return { ok: true };
    },
  );
}
