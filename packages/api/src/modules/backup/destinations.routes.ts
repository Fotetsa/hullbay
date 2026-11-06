import type { FastifyInstance } from "fastify"
import { z } from "zod"
import {
  BackupDestinationFieldsSchema,
  CreateBackupDestinationSchema,
} from "@hullbay/shared"
import { requireRole } from "../auth/rbac"
import { effectiveTenantId } from "../auth/tenancy/tenant-resolver"
import { backupDestinationService } from "./destinations.service"

/**
 * Destinations de sauvegarde — credentials sensibles, donc owner uniquement
 * (même régime que le registry Docker).
 *
 * Aucune réponse ne contient de secret : le service renvoie une vue publique et
 * `configEncrypted` n'est jamais sérialisée.
 */

const owner = { preHandler: requireRole("owner") }
// Lecture = operator : la vue publique ne contient AUCUN secret, et un operator
// doit pouvoir choisir une destination en créant une policy. Toute mutation
// (create/update/delete) et le test de capacité restent owner.
const operator = { preHandler: requireRole("operator") }

const updateBody = z
  .object({
    name: z.string().min(1).optional(),
    basePath: z
      .string()
      .min(1)
      .refine((v) => !v.startsWith("/"), { message: "basePath relatif requis" })
      .optional(),
    config: BackupDestinationFieldsSchema.optional(),
  })
  .strict()

export async function registerBackupDestinationsRoutes(app: FastifyInstance) {
  app.get(
    "/api/backup/destinations",
    {
      ...operator,
      schema: {
        tags: ["backup"],
        summary: "Lister les destinations de sauvegarde (vue publique, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) =>
      backupDestinationService.list(effectiveTenantId(req)),
  )

  app.post(
    "/api/backup/destinations",
    {
      ...owner,
      schema: {
        body: CreateBackupDestinationSchema,
        tags: ["backup"],
        summary: "Créer une destination de sauvegarde (owner)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof CreateBackupDestinationSchema>
      const created = await backupDestinationService.create(
        body,
        effectiveTenantId(req),
      )
      return reply.code(201).send(created)
    },
  )

  app.get(
    "/api/backup/destinations/:id",
    {
      ...operator,
      schema: {
        tags: ["backup"],
        summary: "Détail d'une destination (vue publique, operator)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string }
      return backupDestinationService.get(id, effectiveTenantId(req))
    },
  )

  app.patch(
    "/api/backup/destinations/:id",
    {
      ...owner,
      schema: {
        body: updateBody,
        tags: ["backup"],
        summary: "Modifier une destination (owner)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const { id } = req.params as { id: string }
      const body = req.body as z.infer<typeof updateBody>
      return backupDestinationService.update(
        id,
        effectiveTenantId(req),
        body,
      )
    },
  )

  app.delete(
    "/api/backup/destinations/:id",
    {
      ...owner,
      schema: {
        tags: ["backup"],
        summary: "Supprimer une destination (owner)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      await backupDestinationService.remove(id, effectiveTenantId(req))
      return reply.code(204).send()
    },
  )
}
