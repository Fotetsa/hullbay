import type { FastifyInstance, FastifyRequest } from "fastify"
import { projectsService } from "../projects/service"
import { ReconcilerService} from "./service"
import { DockerEngineService } from "../docker-engine/service"
import { rebuildFromDocker } from "./rebuild"
import { deployProjectWorkflow, DeployError } from "../../workflows/deploy-project"
import { TunnelError } from "../../lib/ssh-tunnel"
import { invalidateDockerClient } from "../docker-engine/client"
import { eventBus } from "../../lib/event-bus"
import { prisma } from "../../lib/prisma"
import { requireRole, currentUser } from "../auth/rbac"
import { pruneOrphans } from "../../jobs/prune-orphans"
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../../lib/concurrency"

const operator = { preHandler: requireRole("operator") }
const owner = { preHandler: requireRole("owner") }

/**
 * Routes du moteur : déployer / détruire un projet, et rebuildFromDocker.
 * Le déploiement est IDEMPOTENT et émet des events de progression (WS).
 *
 * NB : un verrou simple par projet évite deux déploiements concurrents (le plan
 * recommande locking-redis ; ici un Set en mémoire suffit pour le mono-process V1).
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */
const deployingProjects = new Set<string>()

export async function registerReconcilerRoutes(app: FastifyInstance) {
  // Aperçu du diff sans appliquer.
  app.get(
    "/api/projects/:id/plan",
    {
      schema: {
        tags: ["reconciler"],
        summary:
          "Plan de déploiement (diff désiré -> réel) pour un projet donné",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const graph = await projectsService.getProjectGraph(id);
      if (!graph) return reply.code(404).send({ error: "project not found" });
      const engine = await DockerEngineService.forCluster(graph.clusterId)
      const reconciler = await new ReconcilerService(engine)
      return reconciler.plan(graph);
    },
  );

  // Déployer (desired -> real).
  app.post(
    "/api/projects/:id/deploy",
    {
      ...operator,
      schema: {
        tags: ["reconciler"],
        summary: "Déployer un projet (desired -> real) — audité",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (deployingProjects.has(id)) {
        return reply.code(409).send({ error: "déploiement déjà en cours" });
      }
      const graph = await projectsService.getProjectGraph(id);
      if (!graph) return reply.code(404).send({ error: "project not found" });

      const userId = currentUser(req)?.sub;
      deployingProjects.add(id);
      await eventBus.emit("deploy.started", { projectId: id, userId });
      try {
        // Workflow avec steps + compensation (rollback si échec partiel).
        // Retry unique en cas d'erreur tunnel (ECONNREFUSED / EPIPE / socket hang up) :
        // le tunnel SSH peut être mort depuis le dernier usage → on purge le
        // cache Docker ET le tunnel, puis on réessaie une fois avec un tunnel frais.
        let log: string[];
        try {
          log = await deployProjectWorkflow({ graph, createdBy: userId });
        } catch (firstErr) {
          const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          const isTunnelRetryable =
            msg.includes("ECONNREFUSED") ||
            msg.includes("EPIPE") ||
            msg.includes("socket hang up") ||
            firstErr instanceof TunnelError;
          if (!isTunnelRetryable) throw firstErr;
          console.log(`[deploy] 1er essai échoué (${msg}) — retry avec tunnel frais…`);
          invalidateDockerClient(graph.clusterId);
          log = await deployProjectWorkflow({ graph, createdBy: userId });
        }
        await projectsService.updateProject(id, { status: "deployed" });
        await eventBus.emit("deploy.finished", {
          projectId: id,
          userId,
          ok: true,
          log,
        });
        return { ok: true, log };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await projectsService.updateProject(id, { status: "error" });
        await eventBus.emit("deploy.finished", {
          projectId: id,
          userId,
          ok: false,
          error: message,
        });
        // Erreur MÉTIER prévisible (image, garde multi-nœuds, secret…) → 422 + message
        // propre. Sinon vrai bug serveur → 500.
        const status =
          err instanceof DeployError ? 422 :
          err instanceof TunnelError ? err.statusCode :
          500;
        return reply.code(status).send({ ok: false, error: message });
      } finally {
        deployingProjects.delete(id);
      }
    },
  );

  // Détruire toutes les ressources gérées du projet.
  app.post(
    "/api/projects/:id/destroy",
    {
      ...operator,
      schema: {
        tags: ["reconciler"],
        summary: "Destruction de tous les ressources gérées",
        security: [{ bearerAuth: []}],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const graph = await projectsService.getProjectGraph(id);
      if (!graph) return reply.code(404).send({ error: "project not found" });
      const engine = await DockerEngineService.forCluster(graph.clusterId)
      const reconciler = new ReconcilerService(engine)
      const log = await reconciler.destroy(graph);
      await projectsService.updateProject(id, { status: "draft" });
      // Réinitialise l'état runtime observé.
      await prisma.node.updateMany({
        where: { projectId: id },
        data: { actualState: "missing", dockerId: null },
      });
      await eventBus.emit("destroy.finished", {
        projectId: id,
        userId: currentUser(req)?.sub,
        log,
      });
      return { ok: true, log };
    },
  );

  // Reconstruire le désiré depuis Docker (résilience Postgres perdu).
  app.post(
    "/api/rebuild-from-docker",
    {
      ...operator,
      schema: {
        tags: ["reconciler"],
        summary: "Reconstruction depuis docker",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const clusters = await prisma.cluster.findMany({ select: { id: true } })
      const { items, totalMs } = await runWithConcurrency(
        clusters.map((c) => c.id),
        CLUSTER_CONCURRENCY,
        (clusterId) => rebuildFromDocker(clusterId),
      )
      let total = { projects: 0, nodes: 0, edges: 0, degraded: 0 }
      for (const it of items) {
        if (it.status === "fulfilled" && it.value) {
          total.projects += it.value.projects; total.nodes += it.value.nodes
          total.edges += it.value.edges; total.degraded += it.value.degraded
        }
      }
      console.log(`[reconciler] rebuild ${clusters.length} clusters en ${totalMs.toFixed(0)}ms (concurrency=${CLUSTER_CONCURRENCY})`)
      return { ok: true, ...total };
    },
  );

  // Prune des ressources gérées orphelines. GET = dry-run (aperçu, operator),
  // POST = applique la suppression (destructif, owner uniquement).
  app.get("/api/prune", {
    ...operator,
    schema: {
      tags: ["reconciler"],
      security: [{ bearerAuth: []}],
    },
  }, async () => {
    return pruneOrphans(false)
  })
  app.post("/api/prune", {
    ...owner,
    schema: {
      tags: ["reconciler"],
      security: [{ bearerAuth: []}],
    },
  }, async () => {
    return pruneOrphans(true)
  })
}
