import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clusterService } from "./service";
import { requireRole } from "../auth/rbac";

const owner = { preHandler: requireRole("owner") };

export async function registerClustersRoutes(app: FastifyInstance) {
  app.get(
    "/api/clusters",
    {
      ...owner,
      schema: {
        tags: ["clusters"],
        summary: "Lister les clusters (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => clusterService.list(),
  );

  const idParams = z.object({ id: z.string() });
  const deleteQuery = z.object({ teardown: z.coerce.boolean().optional() });

  app.get(
    "/api/clusters/:id",
    {
      ...owner,
      schema: {
        params: idParams,
        tags: ["clusters"],
        summary: "Détail d'un cluster (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const cluster = await clusterService.get(id);
      if (!cluster)
        return reply.code(404).send({ error: "cluster introuvable" });
      return cluster;
    },
  );

  app.delete(
    "/api/clusters/:id",
    {
      ...owner,
      schema: {
        params: idParams,
        querystring: deleteQuery,
        tags: ["clusters"],
        summary: "Supprimer un cluster pending/failed, avec teardown optionnel des serveurs (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { teardown } = req.query as { teardown?: boolean }
      try {
        const result = await clusterService.remove(id, { teardown });
        return { ok: true, ...result };
      } catch (err) {
        const statusCode = (err as Error & { statusCode?: number }).statusCode;
        if (statusCode) {
          return reply
            .code(statusCode)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
        req.log.error(err, "suppression de cluster: erreur inattendue");
        return reply
          .code(500)
          .send({ error: "erreur interne lors de la suppression du cluster" });
      }
    },
  );
}
