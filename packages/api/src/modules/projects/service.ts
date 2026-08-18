import { randomBytes } from "node:crypto"
import { prisma } from "../../lib/prisma"
import {
  parseNodeConfig,
  edgeKindForPair,
  type NodeType,
  type ProjectGraph,
} from "@hullbay/shared"
import { clusterService } from "../clusters/service"

/** Dérive un slug Docker-valide depuis un nom libre (sans accents, minuscules, tirets). */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Service CRUD des projets/nœuds/liens (le DÉSIRÉ, persisté dans Postgres).
 * Calque l'esprit MedusaService : opérations simples, la logique métier (deploy,
 * diff) vit dans les workflows. Valide la config des nœuds via les schémas Zod
 * partagés (@hullbay/shared).
 */
export class ProjectsService {
  // ── Projects ──────────────────────────────────────────────────────────────

  listProjects() {
    return prisma.project.findMany({ orderBy: { updatedAt: "desc" } })
  }

  async getProjectGraph(id: string): Promise<ProjectGraph | null> {
    const project = await prisma.project.findUnique({
      where: { id },
      include: { nodes: true, edges: true },
    })
    if (!project) return null
    return project as unknown as ProjectGraph
  }

  /**
   * Crée un projet. Le slug est dérivé du nom + un suffixe court aléatoire pour
   * garantir l'unicité (le slug préfixe les noms Docker, donc doit être unique).
   * Ex: "Boutique Prod" -> "boutique-prod-a3f8".
   */
  async createProject(input: { name: string; description?: string; clusterId?: string }) {
    const slug = `${slugify(input.name) || "projet"}-${randomBytes(2).toString("hex")}`
    const targetClusterId = input.clusterId ?? (await clusterService.getDefault()).id
    return prisma.project.create({
      data: { name: input.name, slug, description: input.description, clusterId: targetClusterId },
    })
  }

  updateProject(
    id: string,
    data: Partial<{ name: string; description: string; status: string }>
  ) {
    return prisma.project.update({ where: { id }, data })
  }

  deleteProject(id: string) {
    return prisma.project.delete({ where: { id } })
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────

  createNode(input: {
    projectId: string
    type: NodeType
    name: string
    posX: number
    posY: number
    config: unknown
  }) {
    // Valide la config selon le type (lève si invalide).
    const config = parseNodeConfig(input.type, input.config)
    return prisma.node.create({
      data: {
        projectId: input.projectId,
        type: input.type,
        name: input.name,
        posX: input.posX,
        posY: input.posY,
        config: config as object,
      },
    })
  }

  async updateNode(
    id: string,
    data: Partial<{ name: string; posX: number; posY: number; config: unknown }>
  ) {
    // Si la config change, la revalider selon le type courant du nœud.
    let configToSave: object | undefined
    if (data.config !== undefined) {
      const node = await prisma.node.findUniqueOrThrow({ where: { id } })
      configToSave = parseNodeConfig(node.type as NodeType, data.config) as object
    }
    return prisma.node.update({
      where: { id },
      data: {
        name: data.name,
        posX: data.posX,
        posY: data.posY,
        ...(configToSave !== undefined ? { config: configToSave } : {}),
      },
    })
  }

  deleteNode(id: string) {
    return prisma.node.delete({ where: { id } })
  }

  // ── Edges ─────────────────────────────────────────────────────────────────

  /**
   * Crée un edge. Le `kind` détermine la sémantique du lien (réseau / volume /
   * passerelle) et pilote le déploiement. Validation STRICTE via la matrice de
   * compatibilité partagée (GNS3-like) : une paire de types qui n'a pas de sens
   * (ex: volume<->gateway) est REJETÉE, jamais silencieusement réinterprétée. Si
   * le client envoie un `kind` explicite incohérent avec la paire, on rejette
   * aussi plutôt que d'utiliser le kind déduit en silence — aucun flux UI légitime
   * n'envoie un kind incohérent (il vient de l'id du handle utilisé au drag), donc
   * ça ne bloque que les tentatives de contournement de la validation front.
   */
  async createEdge(input: {
    projectId: string
    sourceNodeId: string
    targetNodeId: string
    kind?: string
    config?: object | null
  }) {
    const sourceType = await this.nodeType(input.sourceNodeId)
    const targetType = await this.nodeType(input.targetNodeId)
    const inferredKind = edgeKindForPair(sourceType, targetType)
    if (!inferredKind) {
      throw new Error(
        `Connexion interdite : ${sourceType} ne peut pas se relier directement à ${targetType}.`
      )
    }
    const kind = input.kind ?? inferredKind
    if (kind !== inferredKind) {
      throw new Error(
        `Kind "${kind}" incohérent avec la paire ${sourceType}/${targetType} (attendu "${inferredKind}").`
      )
    }
    return prisma.edge.create({
      data: {
        projectId: input.projectId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        kind,
        config: input.config ?? undefined,
      },
    })
  }

  private async nodeType(nodeId: string): Promise<NodeType> {
    const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } })
    return node.type as NodeType
  }

  updateEdge(id: string, data: { config?: object | null }) {
    return prisma.edge.update({ where: { id }, data: { config: data.config ?? undefined } })
  }

  deleteEdge(id: string) {
    return prisma.edge.delete({ where: { id } })
  }
}

export const projectsService = new ProjectsService()
