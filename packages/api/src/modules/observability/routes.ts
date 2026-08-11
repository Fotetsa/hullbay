import type { FastifyInstance, FastifyRequest } from "fastify"
import { ObservabilityService, systemHealth } from "./service"
import { driftTracker } from "./drift"
import { requireRole } from "../auth/rbac"
import { prisma } from "../../lib/prisma"

const viewer = { preHandler: requireRole("viewer") }

/**
 * Routes d'observabilité (lecture seule, accessibles à tous les rôles connectés) :
 *  - santé cluster (nœuds Swarm + métriques par service)
 *  - métriques fines d'un service (replicas running/desired, CPU/mém)
 *  - snapshot de drift courant (pour badges canvas)
 *
 * La réconciliation effective (corriger le drift) passe par /deploy existant
 * (rôle operator) — pas dupliquée ici.
 * 
 * la Validation des schema Zod (body, params, query) est effectuee automatiquement
 * par Fastify via le plugin fastify-zod avant que le handler ne s'execute. En cas d'erreur, 
 * Fastify retourne un 400 avec le details de l'erreur. pas besoin de safeParse() manuel.
 */
export async function registerObservabilityRoutes(app: FastifyInstance) {
  app.get(
    "/api/health/cluster",
    {
      ...viewer,
      schema: {
        tags: ["observability"],
        summary: "Santé du cluster (nœuds Swarm + métriques par service)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => ({ clusters: await systemHealth() }),
  );

  app.get(
    "/api/services/:id/metrics",
    {
      ...viewer,
      schema: {
        tags: ["observability"],
        summary: "Santé d'un service (replicas, CPU, mémoire)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const node = await prisma.node.findFirst({ where: { dockerId: id }, include: { project: true } })
      if (!node) return reply.code(404).send({ error: "service introuvable "})
      try {
        const svc = await ObservabilityService.forCluster(node.project.clusterId)
        return await svc.serviceHealth(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: message });
      }
    },
  );

  app.get("/api/drift", {
    ...viewer,
    schema: {
      tags: ["observability"],
      summary: "Snapshot de drift courant (pour badges canvas)",
      security: [{ bearerAuth: []}],
    }
  }, async () => {drift: driftTracker.snapshot() }),

  // Sur quel(s) serveur(s) un projet tourne réellement (placement des tasks Swarm).
  app.get("/api/projects/:id/placement", {
    ...viewer,
    schema: {
      tags: ["observability"],
      summary: "Placement d'un projet (serveurs où il tourne)",
      security: [{ bearerAuth: []}],
    }
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await prisma.project.findUnique({ where: { id } })
    if (!project) return reply.code(404).send({ error: "projet intouvable" })
    const svc = await ObservabilityService.forCluster(project.clusterId)
    const list = await svc.projectPlacements(id)
    return { servers: list[0]?.servers ?? [] }
  })
}
