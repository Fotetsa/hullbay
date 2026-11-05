import { randomBytes } from "node:crypto"
import { prisma } from "../../lib/prisma"
import {
  parseNodeConfig,
  edgeKindForPair,
  type NodeType,
  type ProjectGraph,
} from "@hullbay/shared"
import { clusterService } from "../clusters/service"
import { backupTargetService } from "../backup/targets.service"
import { DEFAULT_TENANT_ID } from "../auth/identity/auth-identity.service"

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

  listProjects(tenantId = DEFAULT_TENANT_ID) {
    return prisma.project.findMany({
      where: { tenantId },
      orderBy: { updatedAt: "desc" },
    })
  }

  async getProjectGraph(id: string, tenantId?: string): Promise<ProjectGraph | null> {
    const project = await prisma.project.findUnique({
      where: { id, ...(tenantId ? { tenantId } : {}) },
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
  async createProject(input: { name: string; description?: string; clusterId?: string; tenantId?: string }) {
    const tenantId = input.tenantId ?? DEFAULT_TENANT_ID
    const slug = `${slugify(input.name) || "projet"}-${randomBytes(2).toString("hex")}`
    // Si un cluster est fourni, il DOIT appartenir au tenant —
    // sinon le projet serait créé sur le cluster d'un AUTRE tenant (fuite d'IDs).
    let targetClusterId = input.clusterId
    if (targetClusterId) {
      const cluster = await clusterService.get(targetClusterId, tenantId)
      if (!cluster) {
        const err = new Error("cluster introuvable") as Error & { statusCode?: number }
        err.statusCode = 404
        throw err
      }
    } else {
      targetClusterId = (await clusterService.getDefault(tenantId)).id
    }
    return prisma.project.create({
      data: { name: input.name, slug, description: input.description, clusterId: targetClusterId, tenantId },
    })
  }

  async updateProject(
    id: string,
    data: Partial<{ name: string; description: string; status: string }>,
    tenantId?: string
  ) {
    const res = await prisma.project.updateMany({
      where: { id, ...(tenantId ? { tenantId } : {}) },
      data,
    })
    return res.count > 0
  }

  async deleteProject(id: string, tenantId?: string) {
    const res = await prisma.project.deleteMany({
      where: { id, ...(tenantId ? { tenantId } : {}) },
    })
    return res.count > 0
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
    data: Partial<{ name: string; posX: number; posY: number; config: unknown }>,
    tenantId?: string
  ) {
    const scopedWhere = { id, ...(tenantId ? { project: { tenantId } } : {}) }
    // Si la config change, la revalider selon le type courant du nœud.
    let configToSave: object | undefined
    let node: Awaited<ReturnType<typeof prisma.node.findUnique>> | null = null
    if (data.config !== undefined) {
      node = await prisma.node.findUnique({ where: scopedWhere })
      if (!node) return { ok: false }
      configToSave = parseNodeConfig(node.type as NodeType, data.config) as object
    }
    const res = await prisma.node.updateMany({
      where: scopedWhere,
      data: {
        name: data.name,
        posX: data.posX,
        posY: data.posY,
        ...(configToSave !== undefined ? { config: configToSave } : {}),
      },
    })
    if (res.count === 0) return { ok: false }

    // Re-sync de la cible de sauvegarde si le moteur du nœud a changé
    // (database → engine, volume → "volume"). Voir BackupTargetService.
    let backupResynced: {
      oldKind: string | null
      newKind: string
      targetId: string
      reused: boolean
      archived: boolean
    } | null = null
    if (node && configToSave) {
      const expectedKind =
        node.type === "database"
          ? (configToSave as { engine?: string }).engine
          : node.type === "volume"
            ? "volume"
            : null
      if (expectedKind) {
        backupResynced = await backupTargetService.reconcileForNode({
          nodeId: node.id,
          tenantId: (tenantId as string) ?? DEFAULT_TENANT_ID,
          projectId: node.projectId,
          expectedKind,
          name: node.name,
        })
      }
    }

    return { ok: true, backupResynced }
  }

  async deleteNode(id: string, tenantId?: string) {
    const res = await prisma.node.deleteMany({
      where: { id, ...(tenantId ? { project: { tenantId } } : {}) },
    })
    return res.count > 0
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
    // Dédup : un même couple de nœuds ne porte qu'UN lien par nature (le sens
    // est indifférent — le canvas traite les paires en non-orienté). Sans ça,
    // re-tirer un lien database existant créait un doublon invisible.
    const duplicate = await prisma.edge.findFirst({
      where: {
        projectId: input.projectId,
        kind,
        OR: [
          { sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId },
          { sourceNodeId: input.targetNodeId, targetNodeId: input.sourceNodeId },
        ],
      },
      select: { id: true },
    })
    if (duplicate) {
      throw new Error("Ces deux nœuds sont déjà reliés par ce type de lien.")
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

  async updateEdge(id: string, data: { config?: object | null }, tenantId?: string) {
    const res = await prisma.edge.updateMany({
      where: { id, ...(tenantId ? { project: { tenantId } } : {}) },
      data: { config: data.config ?? undefined },
    })
    return res.count > 0
  }

  async deleteEdge(id: string, tenantId?: string) {
    const res = await prisma.edge.deleteMany({
      where: { id, ...(tenantId ? { project: { tenantId } } : {}) },
    })
    return res.count > 0
  }
}

export const projectsService = new ProjectsService()
