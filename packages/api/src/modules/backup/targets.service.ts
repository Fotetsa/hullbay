import { parseNodeConfig, type DatabaseConfig, type VolumeConfig } from "@hullbay/shared"
import type { BackupTargetKind } from "@prisma/client"
import { prisma } from "../../lib/prisma"
import { getDatabaseProvider, type ConnectionEndpoint } from "../database"
import { slugify } from "../database/providers/postgres"
import type { StrategyTarget } from "./strategies/types"

/**
 * Targets de sauvegarde : projection d'un Node existant.
 *
 * Aucune duplication d'identifiants : la connexion est résolue à la volée via
 * le provider du moteur, exactement comme pour le déploiement. Le mot de passe
 * reste une référence de Docker Secret.
 */

export interface ResolvedTarget {
  target: StrategyTarget
  /** Réseau overlay à rejoindre pour atteindre la source. */
  networkName: string
  volumeName?: string
}

interface TargetRow {
  id: string
  projectId: string
  tenantId: string
  nodeId: string
  kind: string
  name: string
  archived: boolean
}

export class BackupTargetService {
  async createFromNode(nodeId: string, tenantId: string) {
    const node = await prisma.node.findFirst({
      where: { id: nodeId, project: { tenantId } },
      include: { project: { select: { slug: true, tenantId: true } } },
    })
    if (!node) throw new Error("nœud introuvable pour ce tenant")

    const kind =
      node.type === "database"
        ? parseNodeConfig("database", node.config).engine
        : node.type === "volume"
          ? "volume"
          : null
    if (!kind) {
      throw new Error("seuls les nœuds database et volume sont sauvegardables")
    }

    // Une cible (active ou figée) peut déjà exister pour ce nœud : on la
    // réactive plutôt que d'en créer une doublon (contrainte unique nodeId+kind).
    const existing = await prisma.backupTarget.findFirst({
      where: { nodeId: node.id, tenantId },
      orderBy: [{ archived: "asc" }, { createdAt: "desc" }],
    })
    if (existing) {
      if (existing.archived) {
        const reactivated = await prisma.backupTarget.update({
          where: { id: existing.id },
          data: { archived: false, name: node.name },
        })
        return this.toView(reactivated as TargetRow)
      }
      return this.toView(existing as TargetRow)
    }

    const created = await prisma.backupTarget.create({
      data: {
        projectId: node.projectId,
        tenantId,
        nodeId: node.id,
        kind,
        name: node.name,
      },
    })
    return this.toView(created as TargetRow)
  }

  /**
   * Re-synchronise la cible de sauvegarde d'un nœud quand son moteur change.
   *
   * La cible est liée au `kind` figé à la création : changer le moteur du nœud
   * (ex. postgres → mysql) ne la met pas à jour automatiquement, d'où
   * l'affichage « bloqué » sur l'ancien moteur.
   *
   * Au lieu de supprimer la cible (et ses artifacts en cascade), on la **fige**
   * (`archived = true`) et on désactive ses policies : l'historique reste
   * restaurable. Une cible du nouveau `kind` est alors activée (réutilisée si
   * elle existait déjà d'un swap précédent, sinon créée).
   *
   * @returns un descriptif du changement si un re-sync a eu lieu, sinon `null`.
   */
  async reconcileForNode(params: {
    nodeId: string
    tenantId: string
    projectId: string
    expectedKind: string
    name: string
  }): Promise<{
    oldKind: string | null
    newKind: string
    targetId: string
    reused: boolean
    archived: boolean
  } | null> {
    const active = await prisma.backupTarget.findFirst({
      where: { nodeId: params.nodeId, tenantId: params.tenantId, archived: false },
    })
    // Pas de cible active = backup non activé sur ce nœud : rien à re-sync.
    if (!active) return null
    if (active.kind === params.expectedKind) return null

    let oldKind: string | null = null
    if (active) {
      oldKind = active.kind
      // Fige l'ancienne cible (au lieu de la supprimer en cascade) et désactive
      // ses policies : l'historique (artifacts) reste restaurable.
      await prisma.backupTarget.update({
        where: { id: active.id },
        data: { archived: true },
      })
      await prisma.backupPolicy.updateMany({
        where: { targetId: active.id },
        data: { enabled: false },
      })
    }

    // Swap-back : une cible du kind attendu existe déjà (figée précédemment) →
    // on la réactive plutôt que d'en créer une doublon (contrainte unique).
    const match = await prisma.backupTarget.findFirst({
      where: {
        nodeId: params.nodeId,
        tenantId: params.tenantId,
        kind: params.expectedKind as BackupTargetKind,
      },
    })
    if (match) {
      if (match.archived) {
        const reactivated = await prisma.backupTarget.update({
          where: { id: match.id },
          data: { archived: false, name: params.name },
        })
        return {
          oldKind,
          newKind: params.expectedKind,
          targetId: reactivated.id,
          reused: true,
          archived: false,
        }
      }
      return {
        oldKind,
        newKind: params.expectedKind,
        targetId: match.id,
        reused: true,
        archived: false,
      }
    }

    const created = await prisma.backupTarget.create({
      data: {
        projectId: params.projectId,
        tenantId: params.tenantId,
        nodeId: params.nodeId,
        kind: params.expectedKind as BackupTargetKind,
        name: params.name,
      },
    })
    return {
      oldKind,
      newKind: params.expectedKind,
      targetId: created.id,
      reused: false,
      archived: false,
    }
  }

  async list(tenantId: string, projectId?: string) {
    const rows = await prisma.backupTarget.findMany({
      where: { tenantId, ...(projectId ? { projectId } : {}) },
      orderBy: { createdAt: "desc" },
    })
    return rows.map((row) => this.toView(row as TargetRow))
  }

  async get(id: string, tenantId: string) {
    return this.toView(await this.findRow(id, tenantId))
  }

  async remove(id: string, tenantId: string): Promise<void> {
    await this.findRow(id, tenantId)
    await prisma.backupTarget.delete({ where: { id } })
  }

  /** Résolution complète pour le runner (connexion + réseau + volume). */
  async resolve(id: string, tenantId: string): Promise<ResolvedTarget> {
    const row = await this.findRow(id, tenantId)
    const node = await prisma.node.findFirst({
      where: { id: row.nodeId, project: { tenantId } },
      include: { project: { select: { slug: true } } },
    })
    if (!node) throw new Error("nœud source introuvable")
    const projectSlug = node.project.slug

    if (row.kind === "volume") {
      const config = parseNodeConfig("volume", node.config) as VolumeConfig
      const volumeName = config.external ? config.externalName! : `boz_${projectSlug}_${node.name}`
      const isDataVolume = config.labels["bozando.database.data"] === "true"
      const allowDataVolume = process.env.BACKUP_ALLOW_DATABASE_VOLUME === "true"
      if (isDataVolume && allowDataVolume) {
        console.warn(
          `[backup] override explicite : sauvegarde du volume de données ${volumeName} (${node.name})`,
        )
      }
      return {
        target: {
          nodeId: node.id,
          name: node.name,
          kind: "volume",
          engine: "volume",
          engineVersion: "1",
          host: volumeName,
          port: 0,
          username: "root",
          volumeName,
          mountPath: "/data",
          isDataVolume,
          allowDataVolume,
        },
        // Un volume n'a pas de réseau : le task le monte directement.
        networkName: "",
        volumeName,
      }
    }

    const config = parseNodeConfig("database", node.config) as DatabaseConfig
    const provider = getDatabaseProvider(config.engine)
    if (!provider) throw new Error(`moteur non supporté : ${config.engine}`)

    const ctx = {
      parentNodeId: node.id,
      parentNode: { id: node.id, name: node.name, type: "database" as const, config },
      projectSlug,
    }
    const endpoints = provider.connection(config, ctx)
    const writer = endpoints.find((e) => e.role === "writer") ?? endpoints[0]
    if (!writer) throw new Error("aucun endpoint de connexion pour cette base")

    return {
      target: {
        nodeId: node.id,
        name: node.name,
        kind: config.engine,
        engine: config.engine,
        engineVersion: config.version,
        host: writer.host,
        port: writer.port,
        database: writer.database,
        username: writer.username,
        passwordSecretRef: writer.passwordSecretRef,
      },
      networkName: `boz_${projectSlug}_${slugify(node.name)}-net`,
    }
  }

  private async findRow(id: string, tenantId: string): Promise<TargetRow> {
    const row = await prisma.backupTarget.findFirst({ where: { id, tenantId } })
    if (!row) throw new Error("cible de sauvegarde introuvable")
    return row as TargetRow
  }

  private toView(row: TargetRow) {
    return {
      id: row.id,
      projectId: row.projectId,
      nodeId: row.nodeId,
      kind: row.kind,
      name: row.name,
      archived: row.archived,
    }
  }
}

export const backupTargetService = new BackupTargetService()
export type { ConnectionEndpoint }
