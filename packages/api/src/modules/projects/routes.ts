import type { FastifyInstance, FastifyRequest  } from "fastify"
import { z } from "zod"
import { NodeType, EdgeKind } from "@bozando-ops/shared"
import { projectsService } from "./service"
import { requireRole } from "../auth/rbac"

/**
 * Routes des projets - validation automatique via fastify-type-provider-zod
 * 
 * La validation des schemas Zod (body, params, query) est effectuee automatiquement
 * par Fastify avant que le handler ne s'execute. En cas d'erreur, Fastify retourne
 * un 400 avec le detail de l'erreur. Pas besoin de safeParse() manuel.
 */


// Routes mutantes = operator minimum ; les GET restent ouverts (viewer inclus).
const operator = { preHandler: requireRole("operator") }

/**
 * Routes REST du module projects (CRUD du désiré). Validation des payloads via Zod.
 * Le déploiement (deploy-project) sera une route séparée du module reconciler.
 */
export async function registerProjectRoutes(app: FastifyInstance) {
  // ── Projects ──
  app.get("/api/projects", {
    schema: {
      tags: ["projects"],
      summary: "Liste des projets (viewer+)",
      security: [{ bearerAuth: []}],
    },
  }, async () => projectsService.listProjects())

  app.get("/api/projects/:id", {
    schema: {
      tags: ["projects"],
      summary: "Détail d'un projet (viewer+)"
    }
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const graph = await projectsService.getProjectGraph(id)
    if (!graph) return reply.code(404).send({ error: "project not found" })
    return graph
  })

  const createProjectBody = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  app.post("/api/projects", {
    ...operator,
    schema: {
      body: createProjectBody,
      tags: ["projects"],
      summary: "Création d'un projet (operator+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req) => {
    return projectsService.createProject(req.body as { name: string; description?: string})
  })

  const updateProjectBody = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  app.patch("/api/projects/:id", {
    ...operator,
    schema: {
      body: updateProjectBody,
      tags: ["projects"],
      summary: "Mise à jour d'un projet (operator+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return await projectsService.updateProject(id, req.body as any)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/projects/:id", {
    ...operator,
    schema: {
      tags: ["projects"],
      summary: "Suppression d'un projet (operator+) — audité",
      security: [{ bearerAuth: []}],
    },
  }, async (req) => {
    const { id } = req.params as { id: string }
    await projectsService.deleteProject(id)
    return { ok: true }
  })

  // ── Nodes ──
  const createNodeBody = z.object({
    type: NodeType,
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    posX: z.number(),
    posY: z.number(),
    config: z.record(z.string(), z.unknown()),
  })
  app.post("/api/projects/:id/nodes", {
    ...operator,
    schema: {
      body: createNodeBody,
      tags: ["projects"],
      summary: "Création d'un noeud dans un projet (operator+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const body = req.body as any
      return await projectsService.createNode({ projectId: id, ...body })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  const updateNodeBody = z.object({
    name: z.string().optional(),
    posX: z.number().optional(),
    posY: z.number().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  app.post("/api/nodes/:nodeId", {
    ...operator,
    schema: {
      body: updateNodeBody,
      tags: ["projects"],
      summary: "Mise à jour d'un noeud (operator+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req, reply) => {
    const { nodeId } = req.params as { nodeId: string }
    try {
      const body = req.body as any
      return await projectsService.updateNode(nodeId, body)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/nodes/:nodeId", {
    ...operator,
    schema: {
      tags: ["projects"],
      summary: "Suppression d'un noeud (operator+) — audité",
      security: [{ bearerAuth: []}],
    },
  }, async (req) => {
    const { nodeId } = req.params as { nodeId: string }
    await projectsService.deleteNode(nodeId)
    return { ok: true }
  })

  // ── Edges ──
  const createEdgeBody = z.object({
    sourceNodeId: z.string(),
    targetNodeId: z.string(),
    kind: EdgeKind.optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  app.post("/api/projects/:id/edges", {
    ...operator,
    schema: {
      body: createEdgeBody,
      tags: ["projects"],
      summary: "Création d'un lien dans un projet (operator+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const body = req.body as { sourceNodeId: string; targetNodeId: string; kind: string; config?: any };
      return await projectsService.createEdge({
        projectId: id,
        sourceNodeId: body.sourceNodeId,
        targetNodeId: body.targetNodeId,
        kind: body.kind,
        config: body.config ?? null,
      })
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  const updateEdgeBody = z.object({
    config: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  app.post("/api/edges/:edgeId", {
    ...operator,
    schema: {
      body: updateEdgeBody,
      tags: ["projects"],
      summary: "Mise à jour d'un lien (operator+)",
      security: [{ bearerAuth: []}],
    },
  }, async (req, reply) => {
    const { edgeId } = req.params as { edgeId: string }
    try {
      const body = req.body as any
      return await projectsService.updateEdge(edgeId, body)
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete("/api/edges/:edgeId", {
    ...operator,
    schema: {
      tags: ["projects"],
      summary: "Suppression d'un lien (operator+) — audité",
      security: [{ bearerAuth: []}],
    },
  }, async (req) => {
    const { edgeId } = req.params as { edgeId: string }
    await projectsService.deleteEdge(edgeId)
    return { ok: true }
  })
}
