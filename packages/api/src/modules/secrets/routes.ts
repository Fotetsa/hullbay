import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"
import { z } from "zod"
import { DockerEngineService } from "../docker-engine/service"
import { requireRole, currentUser } from "../auth/rbac"
import { clusterService } from "../clusters/service"
import { eventBus } from "../../lib/event-bus"
import type { TenantScopedRequest } from "../auth/tenancy/tenant-resolver"

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

const SECRET_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const normalizeSecretName = (value: unknown) => {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  return trimmed
}

const SecretNameSchema = z.preprocess(
  normalizeSecretName,
  z
    .string()
    .min(1, "nom requis")
    .max(128, "nom trop long")
    .regex(SECRET_NAME_RE, "nom invalide (lettres, chiffres, . _ - seulement)")
    .refine((value) => !value.includes(".."), "nom invalide : .. interdit"),
)

const SecretValueSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().min(1, "valeur requise").max(65535, "valeur trop longue"),
)

const SecretItemSchema = z.object({
  name: SecretNameSchema,
  value: SecretValueSchema,
})

const CreateSecretSchema = SecretItemSchema
const BatchCreateSecretSchema = z.object({
  items: z.array(SecretItemSchema).min(1, "aucun secret à créer").max(100, "trop de secrets dans le lot"),
})

const clusterParams = z.object({ clusterId: z.string() })

/** Le cluster cible doit appartenir au tenant de la requête (404 sinon). */
async function ensureClusterInTenant(
  clusterId: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const cluster = await clusterService.get(
    clusterId,
    (req as TenantScopedRequest).tenantId,
  )
  if (!cluster) {
    await reply.code(404).send({ error: "cluster introuvable" })
    return false
  }
  return true
}

export async function registerSecretsRoutes(app: FastifyInstance) {
  // Liste (noms seulement — jamais les valeurs).
  app.get(
    "/api/clusters/:clusterId/secrets",
    {
      ...operator,
      schema: {
        params: clusterParams,
        tags: ["secrets"],
        summary: "Lister les secrets gérés (owner, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { clusterId } = req.params as { clusterId: string }
      if (!(await ensureClusterInTenant(clusterId, req, reply))) return reply
      const engine = await DockerEngineService.forCluster(clusterId)
      const list = await engine.listManagedSecrets()
      return list.map((s) => ({ id: s.id, name: s.name }))
    },
  );

  // Crée / remplace un secret (write-only). Le body n'est PAS journalisé.
  app.post(
    "/api/clusters/:clusterId/secrets",
    {
      ...operator,
      schema: {
        params: clusterParams,
        body: CreateSecretSchema,
        tags: ["secrets"],
        summary: "Créer ou mettre à jour un secret (owner, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { clusterId } = req.params as { clusterId: string }
      if (!(await ensureClusterInTenant(clusterId, req, reply))) return reply
      const { name, value } = req.body as { name: string; value: string };
      const engine = await DockerEngineService.forCluster(clusterId)
      try {
        await engine.upsertSecret(name, value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { statusCode?: number })?.statusCode ?? 409;
        return reply.code(code >= 400 && code < 600 ? code : 409).send({ error: message });
      }
      await eventBus.emit("secret.set", {
        userId: currentUser(req)?.sub,
        clusterId,
        name,
      });
      return { ok: true, name };
    },
  );

  app.post(
    "/api/clusters/:clusterId/secrets/batch",
    {
      ...operator,
      schema: {
        params: clusterParams,
        body: BatchCreateSecretSchema,
        tags: ["secrets"],
        summary: "Créer ou mettre à jour un lot de secrets en une seule requête",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { clusterId } = req.params as { clusterId: string }
      if (!(await ensureClusterInTenant(clusterId, req, reply))) return reply

      const { items } = req.body as { items: Array<{ name: string; value: string }> }
      const engine = await DockerEngineService.forCluster(clusterId)

      try {
        for (const item of items) {
          await engine.upsertSecret(item.name, item.value)
          await eventBus.emit("secret.set", {
            userId: currentUser(req)?.sub,
            clusterId,
            name: item.name,
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = (err as { statusCode?: number })?.statusCode ?? 409
        return reply.code(code >= 400 && code < 600 ? code : 409).send({ error: message })
      }

      return {
        ok: true,
        created: items.length,
        items: items.map((item) => ({ name: item.name, ok: true })),
      }
    },
  )

  app.delete(
    "/api/clusters/:clusterId/secrets/:name",
    {
      ...operator,
      schema: {
        tags: ["secrets"],
        summary: "Supprimer un secret (owner, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { clusterId, name } = req.params as { clusterId: string; name: string };
      if (!(await ensureClusterInTenant(clusterId, req, reply))) return reply
      const engine = await DockerEngineService.forCluster(clusterId)
      try {
        await engine.removeSecret(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(409).send({ error: message });
      }
      await eventBus.emit("secret.removed", {
        userId: currentUser(req)?.sub,
        clusterId,
        name,
      });
      return { ok: true };
    },
  );
}
