import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { updaterService } from "./updater"
import { currentUser, requireRole } from "../auth/rbac"
import { resolveEnvironment } from "../system/service"

/**
 * Routes de mise à jour du système — OWNER uniquement (actions infra sensibles).
 *
 * Le `check` et la liste sont aussi owner-only : ils exposent les versions du
 * système (métadonnées d'infra) et déclenchent des appels réseau GitHub.
 */

// Actions de mise à jour = OWNER (comme serveurs/registre).
const owner = { preHandler: requireRole("owner") }

const applyBody = z.object({
  channel: z.enum(["stable", "beta"]).optional(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "version invalide (attendu x.y.z)")
    .optional(),
})

export async function registerUpdatesRoutes(app: FastifyInstance) {
  // Vérification de mise à jour (dernière release du canal + version courante).
  app.get(
    "/api/updates/check",
    {
      ...owner,
      schema: {
        querystring: z.object({ channel: z.enum(["stable", "beta", "all"]).optional() }),
        tags: ["updates"],
        summary: "Vérifier les mises à jour disponibles (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { channel } = req.query as { channel?: "stable" | "beta" | "all" }
      return updaterService.check(channel)
    },
  )

  // Version + canal courants de l'instance.
  app.get(
    "/api/updates/current",
    {
      ...owner,
      schema: {
        tags: ["updates"],
        summary: "Version courante de l'instance (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => updaterService.current(),
  )

  // Changer le canal de mise à jour (stable/beta) — persisté sur le singleton.
  app.put(
    "/api/updates/channel",
    {
      ...owner,
      schema: {
        body: z.object({ channel: z.enum(["stable", "beta"]) }),
        tags: ["updates"],
        summary: "Changer le canal de mise à jour (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      if (resolveEnvironment() !== "production") {
        return reply.code(409).send({
          error:
            "Les mises à jour automatiques ne sont disponibles qu'en environnement de production.",
        });
      }
      const { channel } = req.body as { channel: "stable" | "beta" }
      await updaterService.setChannel(channel)
      return reply.code(200).send({ ok: true, channel })
    },
  )

  // Historique des mises à jour (traçabilité + rollback).
  app.get(
    "/api/updates/history",
    {
      ...owner,
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          offset: z.coerce.number().int().min(0).optional(),
          status: z.enum(["pending", "running", "success", "failed", "rolled_back"]).optional(),
        }),
        tags: ["updates"],
        summary: "Historique des mises à jour (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { limit, offset, status } = req.query as { limit?: number; offset?: number; status?: string }
      return updaterService.history({ limit, offset, status })
    },
  )

  // Détail d'une mise à jour (steps + logs).
  app.get(
    "/api/updates/status/:id",
    {
      ...owner,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        tags: ["updates"],
        summary: "Statut d'une mise à jour (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const update = await updaterService.status(id)
      if (!update) return reply.code(404).send({ error: "mise à jour introuvable" })
      return update
    },
  )

  // Lancer une mise à jour (202, exécution en arrière-plan suivie via WS).
  app.post(
    "/api/updates/apply",
    {
      ...owner,
      schema: {
        body: applyBody,
        tags: ["updates"],
        summary: "Lancer la mise à jour du système (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      // Les mises à jour n'ont de sens qu'en production, c'est pour cela que nous devons d'abord verifier avant d'appeller 
      if (resolveEnvironment() !== "production") {
        return reply.code(409).send({
          error: "Les mises à jour automatiques ne sont disponibles qu'en environnement de production.",
        })
      }
      const { channel, version } = req.body as { channel?: "stable" | "beta"; version?: string }
      const user = currentUser(req)
      try {
        const id = await updaterService.apply(
          { channel, version },
          user?.sub ?? null,
        )
        return reply.code(202).send({ id, status: "running" })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Conflit : une update est déjà en cours.
        if (message.includes("déjà en cours")) {
          return reply.code(409).send({ error: message })
        }
        return reply.code(400).send({ error: message })
      }
    },
  )

  // Rollback explicite d'une mise à jour (restore dump + ancien tag).
  app.post(
    "/api/updates/:id/rollback",
    {
      ...owner,
      schema: {
        params: z.object({ id: z.string().min(1) }),
        tags: ["updates"],
        summary: "Revenir à la version précédente (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      if (resolveEnvironment() !== "production") {
        return reply.code(409).send({
          error: "Les mises à jour automatiques ne sont disponibles qu'en environnement de production.",
        })
      }
      const { id } = req.params as { id: string }
      const user = currentUser(req)
      try {
        // Le rollback crée un nouvel enregistrement (historique préservé) — on
        // renvoie son id pour que le front suive ce pipeline en direct.
        const rbId = await updaterService.rollback(id, user?.sub ?? null)
        return reply.code(202).send({ id: rbId, status: "running" })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes("introuvable")) return reply.code(404).send({ error: message })
        return reply.code(400).send({ error: message })
      }
    },
  )
}
