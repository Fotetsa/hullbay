import type { FastifyInstance, FastifyRequest } from "fastify"
import type { ProjectGraph } from "@hullbay/shared"
import { projectsService } from "../projects/service"
import { ReconcilerService} from "./service"
import { DockerEngineService } from "../docker-engine/service"
import { rebuildFromDocker } from "./rebuild"
import { deployProjectWorkflow, DeployError } from "../../workflows/deploy-project"
import { TunnelError } from "../../lib/ssh-tunnel"
import { invalidateDockerClient } from "../docker-engine/client"
import { eventBus } from "../../lib/event-bus"
import { prisma } from "../../lib/prisma"
import { currentUser } from "../auth/rbac"
import { requirePermission, fromParam } from "../authorization/http"
import type { ResourceExtractor } from "../authorization/http/resolvers"
import type { Role as LegacyRole } from "../auth/authorization/rbac"
import { pruneOrphans } from "../../jobs/prune-orphans"
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../../lib/concurrency"
import { expandDatabaseGraph, databaseNodePreview } from "../database"
import { DatabaseValidationError } from "../database/validation"
import type { ExpandedProjectGraph } from "../database"
import { clusterService } from "../clusters/service"
import type { TenantScopedRequest } from "../auth/tenancy/tenant-resolver"

const guard = (action: string, legacyMin: LegacyRole, resource?: ResourceExtractor) => ({
  preHandler: requirePermission(action, { resource, legacyMin }),
})

/**
 * Isolation par tenant : un projet d'un autre tenant est traité
 * comme inexistant (404), jamais comme une ressource visible sans permission.
 * Type guard : `graph` est non-null APRÈS le test (narrowing TS).
 */
function ensureTenantScoped(graph: ProjectGraph | null, req: FastifyRequest): graph is ProjectGraph {
  if (!graph) return false
  const tenantId = (req as TenantScopedRequest).tenantId
  const projectTenant = (graph as { tenantId?: string }).tenantId
  return !projectTenant || projectTenant === tenantId
}

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
      ...guard("project.read", "viewer", fromParam("id", "project")),
      schema: {
        tags: ["reconciler"],
        summary:
          "Plan de déploiement (diff désiré -> réel) pour un projet donné",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const graph = await projectsService.getProjectGraph(id, (req as TenantScopedRequest).tenantId);
      if (!ensureTenantScoped(graph, req))
        return reply.code(404).send({ error: "project not found" });
      const engine = await DockerEngineService.forCluster(graph.clusterId)
      const reconciler = await new ReconcilerService(engine)
      // Expansion en lecture seule (moteurs non implémentés ignorés) : le diff
      // doit refléter les MEMBRES générés, sinon /plan serait vide pour la DB.
      let expanded: ExpandedProjectGraph
      try {
        expanded = expandDatabaseGraph(graph, { strict: false })
      } catch (e) {
        const msg = e instanceof DatabaseValidationError ? e.issues.join(" · ") : String(e)
        return reply.code(400).send({ error: msg })
      }
      return reconciler.plan(expanded.graph);
    },
  );

  // Aperçu des ressources générées pour un nœud database (S5-09/10) : liste des
  // membres/consensus/endpoints + endpoints writer/reader, en lecture seule pour
  // l'inspecteur UI. Pure — aucune action Docker.
  // `?draft=` (base64-JSON) : aperçu de la config EN COURS d'édition (non sauvée) —
  // l'inspecteur prévisualise ce que le deploy générera avant d'enregistrer.
  app.get(
    "/api/projects/:id/nodes/:nodeId/preview",
    {
      ...guard("project.read", "viewer", fromParam("id", "project")),
      schema: {
        tags: ["reconciler"],
        summary: "Aperçu des ressources générées d'un nœud database (config sauvée ou brouillon)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id, nodeId } = req.params as { id: string; nodeId: string }
      let graph = await projectsService.getProjectGraph(id, (req as TenantScopedRequest).tenantId)
      if (!ensureTenantScoped(graph, req))
        return reply.code(404).send({ error: "project not found" })
      const draft = (req.query as { draft?: string } | undefined)?.draft
      if (typeof draft === "string" && draft.length > 0) {
        try {
          const draftConfig = JSON.parse(Buffer.from(draft, "base64").toString("utf8"))
          graph = {
            ...graph,
            nodes: graph.nodes.map((n) =>
              n.id === nodeId ? { ...n, config: draftConfig } : n,
            ),
          }
        } catch {
          return reply.code(400).send({ error: "brouillon de config invalide" })
        }
      }
      let preview
      try {
        preview = databaseNodePreview(graph, nodeId)
      } catch (e) {
        const msg = e instanceof DatabaseValidationError ? e.issues.join(" · ") : String(e)
        // Secret du mot de passe pas encore choisi : état de travail NORMAL d'un
        // nœud neuf — retour doux (pas une erreur), l'UI affiche un invit.
        if (msg.includes("passwordSecretRef")) {
          return { resources: [], connections: [], missingPasswordSecret: true }
        }
        return reply.code(400).send({ error: msg })
      }
      if (!preview) return reply.code(404).send({ error: "database node not found" })
      return preview
    },
  );

  
  app.post(
    "/api/projects/:id/deploy",
    {
      ...guard("project.deploy", "operator", fromParam("id", "project")),
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
      const graph = await projectsService.getProjectGraph(
        id,
        (req as TenantScopedRequest).tenantId,
      );
      if (!ensureTenantScoped(graph, req))
        return reply.code(404).send({ error: "project not found" });

      // On refuse de lancer un déploiement sur un cluster qu'on sait déjà ne pas
      // être en état de le recevoir. Le statut "ready" seul ne suffit pas, un
      // cluster peut rester marqué ready en base alors que son Swarm est en
      // réalité tombé, puisque rien ne réévalue ce statut automatiquement pour
      // l'instant. On vérifie donc aussi l'état réel du Swarm, pas seulement ce
      // que dit la base.
      const targetCluster = await clusterService.get(graph.clusterId);
      if (!targetCluster || targetCluster.status !== "ready") {
        return reply.code(409).send({
          error: `le cluster cible n'est pas prêt, statut actuel : ${targetCluster?.status ?? "introuvable"}`,
        });
      }
      const targetEngine = await DockerEngineService.forCluster(
        graph.clusterId,
      );
      if (!(await targetEngine.isSwarmActive())) {
        return reply.code(409).send({
          error:
            "le Swarm de ce cluster n'est pas actif, vérifie qu'au moins un manager répond avant de redéployer",
        });
      }

      const userId = currentUser(req)?.sub;
      const reqTenant = (req as TenantScopedRequest).tenantId;
      deployingProjects.add(id);
      await eventBus.emit("deploy.started", {
        projectId: id,
        userId,
        tenantId: reqTenant,
      });
      try {
        // Workflow avec steps + compensation (rollback si échec partiel).
        // Retry unique en cas d'erreur tunnel (ECONNREFUSED / EPIPE / socket hang up) :
        // le tunnel SSH peut être mort depuis le dernier usage → on purge le
        // cache Docker ET le tunnel, puis on réessaie une fois avec un tunnel frais.
        let log: string[];
        try {
          log = await deployProjectWorkflow({ graph, createdBy: userId });
        } catch (firstErr) {
          const msg =
            firstErr instanceof Error ? firstErr.message : String(firstErr);
          const isTunnelRetryable =
            msg.includes("ECONNREFUSED") ||
            msg.includes("EPIPE") ||
            msg.includes("socket hang up") ||
            firstErr instanceof TunnelError;
          if (!isTunnelRetryable) throw firstErr;
          console.log(
            `[deploy] 1er essai échoué (${msg}) — retry avec tunnel frais…`,
          );
          invalidateDockerClient(graph.clusterId);
          log = await deployProjectWorkflow({ graph, createdBy: userId });
        }
        await projectsService.updateProject(
          id,
          { status: "deployed" },
          (req as TenantScopedRequest).tenantId,
        );
        await eventBus.emit("deploy.finished", {
          projectId: id,
          userId,
          tenantId: reqTenant,
          ok: true,
          log,
        });
        return { ok: true, log };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await projectsService.updateProject(
          id,
          { status: "error" },
          (req as TenantScopedRequest).tenantId,
        );
        await eventBus.emit("deploy.finished", {
          projectId: id,
          userId,
          tenantId: reqTenant,
          ok: false,
          error: message,
        });
        // Erreur MÉTIER prévisible (image, garde multi-nœuds, secret…) → 422 + message
        // propre. Sinon vrai bug serveur → 500.
        const status =
          err instanceof DeployError
            ? 422
            : err instanceof TunnelError
              ? err.statusCode
              : 500;
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
      ...guard("project.destroy", "operator", fromParam("id", "project")),
      schema: {
        tags: ["reconciler"],
        summary: "Destruction de tous les ressources gérées",
        security: [{ bearerAuth: []}],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const graph = await projectsService.getProjectGraph(id, (req as TenantScopedRequest).tenantId);
      if (!ensureTenantScoped(graph, req))
        return reply.code(404).send({ error: "project not found" });
      const engine = await DockerEngineService.forCluster(graph.clusterId)
      const reconciler = new ReconcilerService(engine)
      // Destruction des ressources générées (membres inclus) ; les volumes de
      // données sont RETENUS par reconciler.destroy (label bozando.database.data).
      // Une config DB corrompue ne doit JAMAIS rendre le projet indestructible :
      // fallback sur le graphe brut (nœud database ≠ conteneur → ignoré par destroy).
      let expanded: ExpandedProjectGraph | null = null
      try {
        expanded = expandDatabaseGraph(graph, { strict: false })
      } catch (err) {
        req.log?.warn?.(`expansion ignorée au destroy (grappe brute utilisée) : ${err instanceof Error ? err.message : err}`)
      }
      const graphToDestroy = expanded?.graph ?? graph
      // Rétention LIVE : le destroy distingue les volumes de données PRÉSENTS dans
      // le graphe (décision de config AUSSI quand retain=false, car Docker ne met
      // pas à jour les labels d'un volume existant) des orphelins (garde par label).
      const retainedVolumeNames = new Set<string>()
      const managedDataVolumeNames = new Set<string>()
      for (const [nodeId, own] of expanded?.ownership ?? []) {
        if (own.role !== "volume" || !own.data) continue
        const volNode = graphToDestroy.nodes.find((n) => n.id === nodeId)
        if (!volNode) continue
        const dockerName = `boz_${graphToDestroy.slug}_${volNode.name}`
        if (own.parentConfig.retainDataOnDelete) retainedVolumeNames.add(dockerName)
        managedDataVolumeNames.add(dockerName)
      }
      const log = await reconciler.destroy(graphToDestroy, {
        retainedVolumeNames,
        managedDataVolumeNames,
      });
      await projectsService.updateProject(id, { status: "draft" }, (req as TenantScopedRequest).tenantId);
      // Réinitialise l'état runtime observé.
      await prisma.node.updateMany({
        where: { projectId: id },
        data: { actualState: "missing", dockerId: null },
      });
      await eventBus.emit("destroy.finished", {
        projectId: id,
        userId: currentUser(req)?.sub,
        tenantId: (req as TenantScopedRequest).tenantId,
        log,
      });
      return { ok: true, log };
    },
  );

  // Reconstruire le désiré depuis Docker (résilience Postgres perdu).
  app.post(
    "/api/rebuild-from-docker",
    {
      ...guard("project.rebuild", "operator"),
      schema: {
        tags: ["reconciler"],
        summary: "Reconstruction depuis docker",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const tenantId = (req as TenantScopedRequest).tenantId;
      const clusters = await prisma.cluster.findMany({
        where: { tenantId },
        select: { id: true, status: true },
      });
      // Garde : ne reconstruire que sur des clusters prêts ; un cluster
      // pending/failed ne doit pas servir de base de reconstruction.
      const candidates = clusters.filter((c) => c.status === "ready");
      const skippedUnready = clusters.length - candidates.length;
      const { items, totalMs } = await runWithConcurrency(
        candidates.map((c) => c.id),
        CLUSTER_CONCURRENCY,
        async (clusterId) => {
          const engine = await DockerEngineService.forCluster(clusterId);
          if (!(await engine.isSwarmActive())) {
            return {
              projects: 0,
              nodes: 0,
              edges: 0,
              degraded: 0,
              skipped: true,
            };
          }
          return { ...(await rebuildFromDocker(clusterId)), skipped: false };
        },
      );
      let total = { projects: 0, nodes: 0, edges: 0, degraded: 0 };
      let skippedSwarmInactive = 0;
      let failed = 0;
      for (const it of items) {
        if (it.status === "fulfilled" && it.value) {
          total.projects += it.value.projects;
          total.nodes += it.value.nodes;
          total.edges += it.value.edges;
          total.degraded += it.value.degraded;
          if (it.value.skipped) skippedSwarmInactive++;
        } else if (it.status === "rejected") {
          // Cluster ready mais injoignable : ni reconstruit, ni compté en skip
          // silencieux — on le remonte pour que l'opérateur voie l'échec.
          failed++;
        }
      }
      const skipped = skippedUnready + skippedSwarmInactive;
      console.log(
        `[reconciler] rebuild ${candidates.length} clusters en ${totalMs.toFixed(0)}ms (concurrency=${CLUSTER_CONCURRENCY}, skip=${skipped}, failed=${failed})`,
      );
      return { ok: true, ...total, skipped, failed };
    },
  );

  // Prune des ressources gérées orphelines. GET = dry-run (aperçu, operator),
  // POST = applique la suppression (destructif, owner uniquement).
  app.get(
    "/api/prune",
    {
      ...guard("prune.dry", "operator"),
      schema: {
        tags: ["reconciler"],
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      return pruneOrphans(false);
    },
  );
  app.post("/api/prune", {
    ...guard("prune.apply", "owner"),
    schema: {
      tags: ["reconciler"],
      security: [{ bearerAuth: []}],
    },
  }, async () => {
    return pruneOrphans(true)
  })
}
