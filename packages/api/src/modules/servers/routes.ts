import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { serversService } from "./service"
import { provisionServerWorkflow } from "../../workflows/provision-server"
import { DockerEngineService } from "../docker-engine/service"
import { requireRole, currentUser } from "../auth/rbac"
import { eventBus } from "../../lib/event-bus"


/**
 * Routes des serveurs - validation automatique via fastify-type-provider-zod
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */


// Provisionner / retirer des serveurs = OWNER uniquement (action infra sensible).
const owner = { preHandler: requireRole("owner") }
const localDocker = new DockerEngineService()

export async function registerServersRoutes(app: FastifyInstance) {
  // Liste des serveurs (croisée avec l'état Swarm réel, best effort).
  // Owner-only : la gestion d'infra est réservée (et évite toute fuite de métadonnées serveur).
  app.get("/api/servers", {
    ...owner,
    schema: {
      tags: ["servers"],
      summary: "Lister les serveurs connus (owner uniquement)",
      security: [{ bearerAuth: []}],
    },
  }, async () => {
    const servers = await serversService.list()
    let nodes: unknown[] = []
    let managers = { total: 0, reachable: 0, quorumOk: false }
    try {
      nodes = await localDocker.listNodes()
      managers = await localDocker.managerHealth()
    } catch {
      // Swarm peut être inactif
    }
    return { servers, swarmNodes: nodes.length, managers }
  })

  // Provisionner un nouveau serveur. La credential PERSO n'est jamais persistée.
  const provisionBody = z.object({
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().min(1).default("root"),
    // Rôle explicite optionnel : "manager" pour ajouter un manager (HA quorum Raft).
    // Par défaut, 1er serveur = manager, suivants = worker.
    role: z.enum(["manager", "worker"]).optional(),
    credential: z.discriminatedUnion("type", [
      z.object({ type: z.literal("key"), privateKey: z.string().min(1), passphrase: z.string().optional() }),
      z.object({ type: z.literal("password"), password: z.string().min(1) }),
    ]),
  })

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
      const { name, host, port, user, credential } = req.body as {
        name: string;
        host: string;
        port: number;
        user: string;
        role?: "manager" | "worker";
        credential:
          | { type: "key"; privateKey: string; passphrase?: string }
          | { type: "password"; password: string };
      };

      // Rôle : explicite si fourni, sinon 1er serveur = manager / suivants = worker.
      const body = req.body as any;
      const role = body.role ?? ((await serversService.hasManager()) ? "worker" : "manager");
      const server = await serversService.create({
        name,
        host,
        port,
        user,
        role,
      });

      // Provisioning en arrière-plan : on répond tout de suite, le front suit via WS.
      void provisionServerWorkflow({
        serverId: server.id,
        host,
        port,
        user,
        role,
        credential,
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
        await localDocker.drainNode(server.swarmNodeId).catch(() => {});
        await localDocker.removeNode(server.swarmNodeId).catch(() => {});
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

  const setRoleBody = z.object({ role: z.enum(["manager", "worker"]) })
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
      if (!server)
        return reply.code(404).send({ error: "serveur introuvable" });
      if (!server.swarmNodeId) {
        return reply
          .code(409)
          .send({ error: "nœud pas encore joint au Swarm" });
      }
      try {
        const body = setRoleBody.parse(req.body);
        await localDocker.setNodeRole(server.swarmNodeId, body.role);
      } catch (err) {
        return reply
          .code(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
      const body = setRoleBody.parse(req.body);
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
