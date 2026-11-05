import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { BackupPolicyInputSchema } from "@hullbay/shared"
import { prisma } from "../../lib/prisma"
import { requireRole } from "../auth/rbac"
import { effectiveTenantId } from "../auth/tenancy/tenant-resolver"
import { backupTargetService } from "./targets.service"
import { backupPolicyService } from "./policies.service"

/**
 * Routes du Backup Engine.
 *
 * - credentials de destination : owner uniquement (comme le registry) ;
 * - cible / policy / run : operator (action d'exploitation, pas de secret) ;
 * - restore : 501 en V1 — contrat réservé, pas de route fantôme.
 */

const owner = { preHandler: requireRole("owner") }
const operator = { preHandler: requireRole("operator") }

const policyPatch = BackupPolicyInputSchema.partial()

export async function registerBackupRoutes(app: FastifyInstance) {
  // ── Destination : test de capacité (owner, credentials sensibles) ──────────
  app.post(
    "/api/backup/destinations/:id/test",
    {
      ...owner,
      schema: {
        tags: ["backup"],
        summary: "Tester les capacités réelles d'une destination",
      },
    },
    async (req) => {
      const { id } = req.params as { id: string }
      return backupPolicyService.testDestination(id, effectiveTenantId(req))
    },
  )

  // ── Cibles ─────────────────────────────────────────────────────────────────
  app.get(
    "/api/backup/targets",
    { ...operator, schema: { tags: ["backup"], summary: "Lister les cibles" } },
    async (req) => {
      const { projectId } = req.query as { projectId?: string }
      return backupTargetService.list(effectiveTenantId(req), projectId)
    },
  )

  app.post(
    "/api/backup/targets",
    {
      ...operator,
      schema: {
        body: z.object({ nodeId: z.string().min(1) }).strict(),
        tags: ["backup"],
        summary: "Créer une cible depuis un nœud database/volume",
      },
    },
    async (req, reply) => {
      const { nodeId } = req.body as { nodeId: string }
      const created = await backupTargetService.createFromNode(
        nodeId,
        effectiveTenantId(req),
      )
      return reply.code(201).send(created)
    },
  )

  app.delete(
    "/api/backup/targets/:id",
    { ...operator, schema: { tags: ["backup"], summary: "Supprimer une cible" } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      await backupTargetService.remove(id, effectiveTenantId(req))
      return reply.code(204).send()
    },
  )

  // ── Policies ───────────────────────────────────────────────────────────────
  app.get(
    "/api/backup/policies",
    { ...operator, schema: { tags: ["backup"], summary: "Lister les policies" } },
    async (req) => {
      const { targetId } = req.query as { targetId?: string }
      return backupPolicyService.list(effectiveTenantId(req), targetId)
    },
  )

  app.post(
    "/api/backup/policies",
    {
      ...operator,
      schema: {
        body: BackupPolicyInputSchema,
        tags: ["backup"],
        summary: "Créer une policy de sauvegarde",
      },
    },
    async (req, reply) => {
      const created = await backupPolicyService.create(
        req.body as z.infer<typeof BackupPolicyInputSchema>,
        effectiveTenantId(req),
      )
      return reply.code(201).send(created)
    },
  )

  app.patch(
    "/api/backup/policies/:id",
    {
      ...operator,
      schema: {
        body: policyPatch,
        tags: ["backup"],
        summary: "Modifier une policy",
      },
    },
    async (req) => {
      const { id } = req.params as { id: string }
      return backupPolicyService.update(
        id,
        effectiveTenantId(req),
        req.body as z.infer<typeof policyPatch>,
      )
    },
  )

  app.delete(
    "/api/backup/policies/:id",
    { ...operator, schema: { tags: ["backup"], summary: "Supprimer une policy" } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      await backupPolicyService.remove(id, effectiveTenantId(req))
      return reply.code(204).send()
    },
  )

  app.post(
    "/api/backup/policies/:id/run",
    {
      ...operator,
      schema: { tags: ["backup"], summary: "Lancer une sauvegarde immédiate" },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const result = await backupPolicyService.runNow(id, effectiveTenantId(req))
      return reply.code(result.ok ? 202 : 422).send(result)
    },
  )

  // ── Historique ─────────────────────────────────────────────────────────────
  app.get(
    "/api/backup/runs",
    { ...operator, schema: { tags: ["backup"], summary: "Historique des exécutions" } },
    async (req) => {
      const { policyId, limit } = req.query as { policyId?: string; limit?: string }
      const rows = await prisma.backupRun.findMany({
        where: {
          ...(policyId ? { policyId } : {}),
          policy: { target: { tenantId: effectiveTenantId(req) } },
        },
        orderBy: { startedAt: "desc" },
        take: Math.min(Number.parseInt(limit ?? "50", 10) || 50, 200),
      })
      return rows.map((row) => ({
        ...row,
        sizeBytes: row.sizeBytes === null ? null : row.sizeBytes.toString(),
      }))
    },
  )

  app.get(
    "/api/backup/artifacts",
    { ...operator, schema: { tags: ["backup"], summary: "Artifacts restaurables" } },
    async (req) => {
      const { targetId, limit } = req.query as { targetId?: string; limit?: string }
      const rows = await prisma.backupArtifact.findMany({
        where: {
          ...(targetId ? { targetId } : {}),
          target: { tenantId: effectiveTenantId(req) },
        },
        orderBy: { committedAt: "desc" },
        take: Math.min(Number.parseInt(limit ?? "50", 10) || 50, 200),
      })
      return rows.map((row) => ({
        id: row.id,
        targetId: row.targetId,
        destinationId: row.destinationId,
        storageKey: row.storageKey,
        payloadFormat: row.payloadFormat,
        checksumSha256: row.checksumSha256,
        sizeBytes: row.sizeBytes.toString(),
        engine: row.engine,
        engineVersion: row.engineVersion,
        strategyId: row.strategyId,
        formatVersion: row.formatVersion,
        committedAt: row.committedAt,
      }))
    },
  )

  app.get(
    "/api/backup/artifacts/:id",
    { ...operator, schema: { tags: ["backup"], summary: "Manifest complet d'un artifact" } },
    async (req) => {
      const { id } = req.params as { id: string }
      const row = await prisma.backupArtifact.findFirst({
        where: { id, target: { tenantId: effectiveTenantId(req) } },
      })
      if (!row) throw new Error("artifact introuvable")
      return {
        id: row.id,
        storageKey: row.storageKey,
        manifest: row.manifestJson,
        sizeBytes: row.sizeBytes.toString(),
      }
    },
  )

  app.post(
    "/api/backup/artifacts/:id/restore",
    { ...owner, schema: { tags: ["backup"], summary: "Restauration (non disponible en V1)" } },
    async (_req, reply) =>
      reply.code(501).send({
        error: "not_implemented",
        code: "not_implemented",
        message:
          "La restauration sera livrée après le MVP. Le manifest de l'artifact contient la procédure standard.",
      }),
  )
}
