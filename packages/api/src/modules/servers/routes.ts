import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { serversService } from "./service"
import { provisionServerWorkflow } from "../../workflows/provision-server"
import { DockerEngineService, LastManagerError } from "../docker-engine/service"
import { requireRole, currentUser } from "../auth/rbac"
import { eventBus } from "../../lib/event-bus"
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../../lib/concurrency"
import { TunnelError } from "../../lib/ssh-tunnel"
import { clusterService } from "../clusters/service"


/**
 * Routes des serveurs - validation automatique via fastify-type-provider-zod
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */


// Provisionner / retirer des serveurs = OWNER uniquement (action infra sensible).
const owner = { preHandler: requireRole("owner") }

export async function registerServersRoutes(app: FastifyInstance) {
  // Liste des serveurs (croisée avec l'état Swarm réel, best effort).
  // Owner-only : la gestion d'infra est réservée (et évite toute fuite de métadonnées serveur).
  app.get(
    "/api/servers",
    {
      ...owner,
      schema: {
        tags: ["servers"],
        summary: "Lister les serveurs connus (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      const servers = await serversService.list();
      const clusterIds = [...new Set(servers.map((s) => s.clusterId))];
      let totalNodes = 0;
      let checkedAny = false;
      const managersAgg = { total: 0, reachable: 0, quorumOk: true };
      const { items, totalMs } = await runWithConcurrency(
        clusterIds,
        CLUSTER_CONCURRENCY,
        async (clusterId) => {
          const engine = await DockerEngineService.forCluster(clusterId);
          return {
            nodes: await engine.listNodes(),
            managers: await engine.managerHealth(),
          };
        },
      );
      for (const it of items) {
        if (it.status === "fulfilled") {
          totalNodes += it.value.nodes.length;
          managersAgg.total += it.value.managers.total;
          managersAgg.reachable += it.value.managers.reachable;
          managersAgg.quorumOk = managersAgg.quorumOk && it.value.managers.quorumOk;
          checkedAny = true;
        } else {
          // Cluster inaccessible : on ignore, on ne bloque pas la liste.
          app.log.warn(`[servers] cluster ${clusterIds[it.index]} injoignable: ${String(it.reason)}`);
        }
      }
      app.log.info(`[servers] health ${clusterIds.length} clusters en ${totalMs.toFixed(0)}ms (concurrency=${CLUSTER_CONCURRENCY})`);
      return {
        servers,
        swarmNodes: totalNodes,
        managers: {
          ...managersAgg,
          quorumOk: checkedAny && managersAgg.quorumOk,
        },
      };
    },
  );

  // Provisionner un nouveau serveur. La credential PERSO n'est jamais persistée.
  const provisionBody = z
    .object({
      name: z.string().min(1),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(22),
      user: z.string().min(1).default("root"),
      // Rôle explicite optionnel : "manager" pour ajouter un manager (HA quorum Raft).
      // Par défaut, 1er serveur = manager, suivants = worker.
      role: z.enum(["manager", "worker"]).optional(),
      clusterId: z.string().optional(),
      newClusterName: z.string().min(1).optional(),
      credential: z.discriminatedUnion("type", [
        z.object({
          type: z.literal("key"),
          privateKey: z.string().min(1),
          passphrase: z.string().optional(),
        }),
        z.object({ type: z.literal("password"), password: z.string().min(1) }),
      ]),
    })
    .refine((b) => Boolean(b.clusterId) !== Boolean(b.newClusterName), {
      message:
        "fournir soit id du cluster existant soit le nom du nouveau cluster, mais pas les deux",
    });

  app.post(
    "/api/servers",
    {
      ...owner,
      schema: {
        body: provisionBody,
        tags: ["servers"],
        summary: "Provisionner un nouveau serveur (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const body = req.body as z.infer<typeof provisionBody>;
      const { name, host, port, user, credential } = body;

      let clusterId: string;
      let role: "manager" | "worker";
      if (body.clusterId) {
        const target = await clusterService.get(body.clusterId);
        if (!target)
          return reply.code(404).send({ error: "cluster introuvable" });
        if (target.status !== "ready") {
          return reply.code(409).send({
            error: `cluster "${target.name}" pas encore prêt (statut: ${target.status})`,
          });
        }
        /**
         * On Verifie ici si le cluster a vraiment un manager qui tourne en ce moment, plutôt que de
         * se fier au statut "ready" du cluster tout seul. Le statut peut rester "ready" en base même
         * si le manager a été retiré depuis, rien ne le repasse en arrière automatiquement. Sans ce
         * contrôle, pourrait laisser quelqu'un rejoindre "worker" un cluster qui n'a plus personne
         * pour delivrer le token de jonction Swarm.
         */
        const hasActiveManager = await serversService.hasManager(body.clusterId);
        clusterId = body.clusterId;
        role = hasActiveManager ? (body.role ?? "worker") : "manager";
      } else {
        try {
          const cluster = await clusterService.createPending(
            body.newClusterName!,
          );
          clusterId = cluster.id;
          role = "manager";
        } catch (err) {
          const statusCode = (err as Error & { statusCode?: number })
            .statusCode;
          if (statusCode) {
            return reply
              .code(statusCode)
              .send({
                error: err instanceof Error ? err.message : String(err),
              });
          }
          req.log.error(err, "création de cluster: erreur inattendue");
          return reply
            .code(500)
            .send({ error: "erreur interne lors de la création du cluster" });
        }
      }
      const server = await serversService.create({
        name,
        host,
        port,
        user,
        role,
        clusterId,
      });

      // Provisioning en arrière-plan : on répond tout de suite, le front suit via WS.
      void provisionServerWorkflow({
        serverId: server.id,
        host,
        port,
        user,
        role,
        credential,
        clusterId,
        isNewCluster: !body.clusterId,
      })
        .then(() =>
          eventBus.emit("server.provisioned", {
            serverId: server.id,
            userId: currentUser(req)?.sub,
          }),
        )
        .catch(() => {
          /* l'erreur est déjà persistée (status=error) + émise sur le WS */
        });

      return reply
        .code(202)
        .send({ id: server.id, role, status: "provisioning" });
    },
  );

  // Retirer un serveur du cluster : drain → node rm → suppression de l'enregistrement.
  app.delete(
    "/api/servers/:id",
    {
      ...owner,
      schema: {
        tags: ["servers"],
        summary: "Retirer un serveur du cluster (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const server = await serversService.get(id);
      if (!server)
        return reply.code(404).send({ error: "serveur introuvable" });
      if (server.swarmNodeId) {
        const engine = await DockerEngineService.forCluster(server.clusterId);
        /**
         * On ne bloque jamais la suppression si le drain ou le retrait échoue, l'utilisateur
         * veut peut-être supprimer un serveur qui n'est déjà plus joignable du tout. Mais on
         * ne veut  non que cet échec passe complétement inaperçu, alors on le consigne, pour qu'un
         * administrateur puisse aller vérifier manuellement si le noeud est resté visible côté Swarm.
         */
        await engine.drainNode(server.swarmNodeId).catch((err) => {
          req.log.warn(
            `impossible de drainer le nœud ${server.swarmNodeId} avant suppression : ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        await engine.removeNode(server.swarmNodeId).catch((err) => {
          req.log.warn(
            `impossible de retirer le nœud ${server.swarmNodeId} du Swarm, il pourrait rester visible côté cluster même après cette suppression : ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      await serversService.remove(id);
      await eventBus.emit("server.removed", {
        serverId: id,
        userId: currentUser(req)?.sub,
      });
      return { ok: true };
    },
  );

  // Promouvoir / rétrograder un nœud (manager <-> worker) — HA quorum Raft.
  // Recommandation : nombre IMPAIR de managers (3 tolère 1 panne, 5 en tolère 2).

  const setRoleBody = z.object({ role: z.enum(["manager", "worker"]) });
app.post(
  "/api/servers/:id/role",
  {
    ...owner,
    schema: {
      body: setRoleBody,
      tags: ["servers"],
      summary: "Promouvoir / rétrograder un nœud (owner uniquement)",
      security: [{ bearerAuth: [] }],
    },
  },
  async (req, reply) => {
    const { id } = req.params as { id: string };
    const server = await serversService.get(id);
    if (!server) return reply.code(404).send({ error: "serveur introuvable" });
    if (!server.swarmNodeId) {
      return reply.code(409).send({ error: "nœud pas encore joint au Swarm" });
    }

    const body = setRoleBody.parse(req.body);

    // On protège le quorum en refusant de rétrograder le dernier manager actif d'un cluster.
    if (body.role === "worker" && server.role === "manager") {
      const activeManagers = await serversService.countReadyManagers(server.clusterId);
      if (activeManagers <= 1) {
        return reply.code(409).send({
          error: "impossible de rétrograder le dernier manager du cluster, le quorum serait perdu",
        });
      }
    }

    try {
      const engine = await DockerEngineService.forCluster(server.clusterId);
      await engine.setNodeRole(server.swarmNodeId, body.role);
    } catch (err) {
      const status = err instanceof TunnelError ? err.statusCode : 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }

    await serversService.update(id, { role: body.role });
    await eventBus.emit("server.role.changed", {
      serverId: id,
      userId: currentUser(req)?.sub,
      role: body.role,
    });
    return { ok: true, role: body.role };
  },
);
}
