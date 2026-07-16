import { z } from "zod"
import { NodeType } from "./node-config.js"

/**
 * Entités du modèle de données, alignées sur le schéma Prisma de l'api.
 * Servent de contrat partagé front/back (payloads API, état du canvas).
 */

export const ProjectStatus = z.enum(["draft", "deployed", "partial", "error"])
export type ProjectStatus = z.infer<typeof ProjectStatus>

/**
 * État réel d'un nœud, observé dans Docker (rempli par l'observer).
 * N'est PAS la source de vérité — c'est un reflet du runtime.
 */
export const ActualState = z.enum([
  "running",
  "exited",
  "created",
  "paused",
  "restarting",
  "dead",
  "missing", // désiré mais absent de Docker
  "unknown",
])
export type ActualState = z.infer<typeof ActualState>

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** Identifiant stable encodé dans bozando.projectId / projectSlug. */
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug: minuscules, chiffres et tirets"),
  description: z.string().nullable().optional(),
  status: ProjectStatus.default("draft"),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
})
export type Project = z.infer<typeof ProjectSchema>

export const NodeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: NodeType,
  /** Nom lisible, unique par projet. Encodé dans bozando.nodeName. */
  name: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "name: alphanumérique, _ et -"),
  /** Position sur le canvas (React Flow). Encodée dans bozando.canvas.x/y. */
  posX: z.number(),
  posY: z.number(),
  /** Config typée selon `type` (voir node-config.ts). Encodée dans bozando.spec. */
  config: z.record(z.string(), z.unknown()),
  // ── Runtime observé (NON source de vérité) ──
  dockerId: z.string().nullable().optional(),
  actualState: ActualState.nullable().optional(),
  /** Hash de la config désirée → détection de drift / idempotence du diff. */
  desiredHash: z.string().nullable().optional(),
})
export type Node = z.infer<typeof NodeSchema>

export const EdgeKind = z.enum(["network", "volume", "gateway"])
export type EdgeKind = z.infer<typeof EdgeKind>

export const EdgeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  kind: EdgeKind.default("network"),
  /** Config du lien : ex { mountPath, readOnly } (volume) ou { port } (gateway). */
  config: z.record(z.string(), z.unknown()).nullable().optional(),
})
export type Edge = z.infer<typeof EdgeSchema>

/** Un projet complet avec son graphe — payload du canvas. */
export const ProjectGraphSchema = ProjectSchema.extend({
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
})
export type ProjectGraph = z.infer<typeof ProjectGraphSchema>
