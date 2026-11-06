import type { FastifyInstance, FastifyRequest  } from "fastify"
import { z } from "zod"
import { NodeType, EdgeKind } from "@hullbay/shared"
import { projectsService } from "./service"
import { requirePermission, fromParam, fromBodyIfPresent } from "../authorization/http"
import type { ResourceExtractor } from "../authorization/http/resolvers"
import type { Role as LegacyRole } from "../auth/authorization/rbac"
import type { TenantScopedRequest } from "../auth/tenancy/tenant-resolver"

/**
 * Routes des projets - validation automatique via fastify-type-provider-zod
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */


// Routes mutantes = operator minimum ; les GET restent ouverts (viewer inclus).
const guard = (
  action: string,
  resource?: ResourceExtractor,
  legacyMin: LegacyRole = "operator",
) => ({
  preHandler: requirePermission(action, { resource, legacyMin }),
});

/**
 * Routes REST du module projects (CRUD du désiré). Validation des payloads via Zod.
 * Le déploiement (deploy-project) sera une route séparée du module reconciler.
 */
export async function registerProjectRoutes(app: FastifyInstance) {
  // ── Projects ──
  app.get("/api/projects", {
    ...guard("project.read", undefined, "viewer"),
    schema: {
      tags: ["projects"],
      summary: "Liste des projets (viewer+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req) => projectsService.listProjects((req as TenantScopedRequest).tenantId))

  app.get("/api/projects/:id", {
    ...guard("project.read", fromParam("id", "project"), "viewer"),
    schema: {
      tags: ["projects"],
      summary: "Détail d'un projet (viewer+)"
    }
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const tenantId = (req as TenantScopedRequest).tenantId
    const graph = await projectsService.getProjectGraph(id, tenantId)
    if (!graph) return reply.code(404).send({ error: "project not found" })
    return graph
  })

  const createProjectBody = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    // Cluster de destination. L'UI le présélectionne ; sans lui, on retombe sur
    // le cluster par défaut (isDefault) — comportement historique conservé.
    clusterId: z.string().optional(),
  })
  app.post(
    "/api/projects",
    {
      ...guard("project.create", fromBodyIfPresent("clusterId", "cluster")),
      schema: {
        body: createProjectBody,
        tags: ["projects"],
        summary: "Création d'un projet (operator+)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = req.body as {
        name: string;
        description?: string;
        clusterId?: string;
      };
      const tenantId = (req as TenantScopedRequest).tenantId;
      return projectsService.createProject({ ...body, tenantId });
    },
  );

  const updateProjectBody = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  app.patch(
    "/api/projects/:id",
    {
      ...guard("project.update", fromParam("id", "project")),
      schema: {
        body: updateProjectBody,
        tags: ["projects"],
        summary: "Mise à jour d'un projet (operator+)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      const ok = await projectsService.updateProject(
        id,
        req.body as any,
        tenantId,
      );
      if (!ok) return reply.code(404).send({ error: "project not found" });
      return { ok: true };
    },
  );

  app.delete(
    "/api/projects/:id",
    {
      ...guard("project.delete", fromParam("id", "project")),
      schema: {
        tags: ["projects"],
        summary: "Suppression d'un projet (operator+) — audité",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      const ok = await projectsService.deleteProject(id, tenantId);
      if (!ok) return reply.code(404).send({ error: "project not found" });
      return { ok: true };
    },
  );

  // ── Nodes ──
  const createNodeBody = z.object({
    type: NodeType,
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    posX: z.number(),
    posY: z.number(),
    config: z.record(z.string(), z.unknown()),
  })
  app.post(
    "/api/projects/:id/nodes",
    {
      ...guard("graph.node.create", fromParam("id", "project")),
      schema: {
        body: createNodeBody,
        tags: ["projects"],
        summary: "Création d'un noeud dans un projet (operator+)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      // Isolation : le projet cible doit appartenir au tenant de la requête.
      if (!(await projectsService.getProjectGraph(id, tenantId)))
        return reply.code(404).send({ error: "project not found" });
      try {
        const body = req.body as any;
        return await projectsService.createNode({ projectId: id, ...body });
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  const updateNodeBody = z.object({
    name: z.string().optional(),
    posX: z.number().optional(),
    posY: z.number().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  app.post(
    "/api/nodes/:nodeId",
    {
      ...guard("graph.node.update", fromParam("nodeId", "node")),
      schema: {
        body: updateNodeBody,
        tags: ["projects"],
        summary: "Mise à jour d'un noeud (operator+)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { nodeId } = req.params as { nodeId: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      try {
        const body = req.body as any;
        const ok = await projectsService.updateNode(nodeId, body, tenantId);
        if (!ok) return reply.code(404).send({ error: "node not found" });
        return { ok: true };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/nodes/:nodeId",
    {
      ...guard("graph.node.delete", fromParam("nodeId", "node")),
      schema: {
        tags: ["projects"],
        summary: "Suppression d'un noeud (operator+) — audité",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { nodeId } = req.params as { nodeId: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      const ok = await projectsService.deleteNode(nodeId, tenantId);
      if (!ok) return reply.code(404).send({ error: "node not found" });
      return { ok: true };
    },
  );

  // ── Edges ──
  const createEdgeBody = z.object({
    sourceNodeId: z.string(),
    targetNodeId: z.string(),
    kind: EdgeKind.optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  app.post(
    "/api/projects/:id/edges",
    {
      ...guard("graph.edge.create", fromParam("id", "project")),
      schema: {
        body: createEdgeBody,
        tags: ["projects"],
        summary: "Création d'un lien dans un projet (operator+)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      // Isolation : le projet cible doit appartenir au tenant de la requête.
      if (!(await projectsService.getProjectGraph(id, tenantId)))
        return reply.code(404).send({ error: "project not found" });
      try {
        const body = req.body as {
          sourceNodeId: string;
          targetNodeId: string;
          kind: string;
          config?: any;
        };
        return await projectsService.createEdge({
          projectId: id,
          sourceNodeId: body.sourceNodeId,
          targetNodeId: body.targetNodeId,
          kind: body.kind,
          config: body.config ?? null,
        });
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  const updateEdgeBody = z.object({
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  app.post(
    "/api/edges/:edgeId",
    {
      ...guard("graph.edge.update", fromParam("edgeId", "edge")),
      schema: {
        body: updateEdgeBody,
        tags: ["projects"],
        summary: "Mise à jour d'un lien (operator+)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { edgeId } = req.params as { edgeId: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      try {
        const body = req.body as any;
        const ok = await projectsService.updateEdge(edgeId, body, tenantId);
        if (!ok) return reply.code(404).send({ error: "edge not found" });
        return { ok: true };
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/edges/:edgeId",
    {
      ...guard("graph.edge.delete", fromParam("edgeId", "edge")),
      schema: {
        tags: ["projects"],
        summary: "Suppression d'un lien (operator+) — audité",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { edgeId } = req.params as { edgeId: string };
      const tenantId = (req as TenantScopedRequest).tenantId;
      const ok = await projectsService.deleteEdge(edgeId, tenantId);
      if (!ok) return reply.code(404).send({ error: "edge not found" });
      return { ok: true };
    },
  );
}
