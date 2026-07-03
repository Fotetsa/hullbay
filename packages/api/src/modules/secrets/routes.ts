import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { DockerEngineService } from "../docker-engine/service"
import { requireRole, currentUser } from "../auth/rbac"
import { eventBus } from "../../lib/event-bus"

/**
 * Module secrets — gère les Docker Secrets (valeurs sensibles HORS labels/env).
 *
 * La VALEUR n'est jamais relue ni journalisée : on la pose une fois (write-only),
 * Swarm la chiffre au repos (Raft) et la monte en fichier read-only dans les
 * services qui la référencent. La config du nœud ne contient que la référence.
 *
 * RBAC : créer/supprimer un secret = operator (sensible mais nécessaire au deploy).
 * La valeur n'est jamais exposée même au owner.
 * 
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */

const operator = { preHandler: requireRole("operator") }

const CreateSecretSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/, "nom invalide (alnum . _ - seulement)"),
  value: z.string().min(1),
})

export async function registerSecretsRoutes(app: FastifyInstance) {
  const engine = new DockerEngineService()

  // Liste (noms seulement — jamais les valeurs).
  app.get(
    "/api/secrets",
    {
      ...operator,
      schema: {
        tags: ["secrets"],
        summary: "Lister les secrets gérés (owner, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const list = await engine.listManagedSecrets();
      return list.map((s) => ({ id: s.id, name: s.name }));
    },
  );

  // Crée / remplace un secret (write-only). Le body n'est PAS journalisé.
  app.post(
    "/api/secrets",
    {
      ...operator,
      schema: {
        body: CreateSecretSchema,
        tags: ["secrets"],
        summary: "Créer ou mettre à jour un secret (owner, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { name, value } = req.body as { name: string; value: string };
      try {
        await engine.upsertSecret(name, value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Cas typique : secret référencé par un service en cours → suppression refusée.
        return reply.code(409).send({ error: message });
      }
      // Audit SANS la valeur.
      await eventBus.emit("secret.set", {
        userId: currentUser(req)?.sub,
        name,
      });
      return { ok: true, name };
    },
  );

  app.delete(
    "/api/secrets/:name",
    {
      ...operator,
      schema: {
        tags: ["secrets"],
        summary: "Supprimer un secret (owner, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string };
      try {
        await engine.removeSecret(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: message });
      }
      await eventBus.emit("secret.removed", {
        userId: currentUser(req)?.sub,
        name,
      });
      return { ok: true };
    },
  );
}
