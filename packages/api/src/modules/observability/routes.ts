import type { FastifyInstance, FastifyRequest } from "fastify"
import { ObservabilityService, systemHealth } from "./service"
import { driftTracker } from "./drift"
import { requirePermission, fromParam } from "../authorization/http"
import type { ResourceExtractor } from "../authorization/http/resolvers"
import { prisma } from "../../lib/prisma"
import { effectiveTenantId, type TenantScopedRequest } from "../auth/tenancy/tenant-resolver"

const guard = (action: string, resource?: ResourceExtractor) => ({
  preHandler: requirePermission(action, { resource, legacyMin: "viewer" }),
})

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
      ...guard("logs.read"),
      schema: {
        tags: ["observability"],
        summary: "Santé du cluster (nœuds Swarm + métriques par service)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => ({ clusters: await systemHealth((req as TenantScopedRequest).tenantId) }),
  );

  app.get(
    "/api/services/:id/metrics",
    {
      ...guard("logs.read"),
      schema: {
        tags: ["observability"],
        summary: "Santé d'un service (replicas, CPU, mémoire)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      const node = await prisma.node.findFirst({
        where: { dockerId: id, project: { tenantId } },
        include: { project: true },
      })
      if (!node) return reply.code(404).send({ error: "service introuvable "})
      try {
        const svc = await ObservabilityService.forCluster(node.project.clusterId, tenantId)
        return await svc.serviceHealth(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: message });
      }
    },
  );

  app.get(
    "/api/drift",
    {
      ...guard("logs.read"),
      schema: {
        tags: ["observability"],
        summary: "Snapshot de drift courant (pour badges canvas)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => ({ drift: driftTracker.snapshot(effectiveTenantId(req)) }),
  );

  // Sur quel(s) serveur(s) un projet tourne réellement (placement des tasks Swarm).
  app.get("/api/projects/:id/placement", {
    ...guard("logs.read", fromParam("id", "project")),
    schema: {
      tags: ["observability"],
      summary: "Placement d'un projet (serveurs où il tourne)",
      security: [{ bearerAuth: []}],
    }
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenantId = (req as TenantScopedRequest).tenantId
    const project = await prisma.project.findUnique({ where: { id, tenantId } })
    if (!project) return reply.code(404).send({ error: "projet intouvable" })
    const svc = await ObservabilityService.forCluster(project.clusterId, tenantId)
    const list = await svc.projectPlacements(id)
    return { servers: list[0]?.servers ?? [] }
  })
}
