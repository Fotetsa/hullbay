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
        tags: ["clusters"],
        summary: "Supprimer un cluster pending/failed (owner uniquement)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await clusterService.remove(id);
        return { ok: true };
      } catch (err) {
        const status =
          (err as Error & { statusCode?: number }).statusCode ?? 500;
        return reply
          .code(status)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );
}
