import type { FastifyInstance } from "fastify"
import { observabilityService } from "./service"
import { requireRole } from "../auth/rbac"

const viewer = { preHandler: requireRole("viewer") }

/**
 * Routes d'observabilité (lecture seule, accessibles à tous les rôles connectés) :
 *  - santé cluster (nœuds Swarm + métriques par service)
 *  - métriques fines d'un service (replicas running/desired, CPU/mém)
 *  - snapshot de drift courant (pour badges canvas)
 *
 * La réconciliation effective (corriger le drift) passe par /deploy existant
 * (rôle operator) — pas dupliquée ici.
 */
export async function registerObservabilityRoutes(app: FastifyInstance) {
  app.get("/api/health/cluster", viewer, async () => {
    return observabilityService.clusterHealth()
  })

  app.get("/api/services/:id/metrics", viewer, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return await observabilityService.serviceHealth(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.code(404).send({ error: message })
    }
  })

  app.get("/api/drift", viewer, async () => {
    return { drift: observabilityService.driftSnapshot() }
  })

  // Sur quel(s) serveur(s) un projet tourne réellement (placement des tasks Swarm).
  app.get("/api/projects/:id/placement", viewer, async (req) => {
    const { id } = req.params as { id: string }
    const list = await observabilityService.projectPlacements(id)
    return { servers: list[0]?.servers ?? [] }
  })
}
