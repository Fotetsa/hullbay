import { Prisma } from "@prisma/client"
import {
  BackupDestinationFieldsSchema,
  BackupDestinationViewSchema,
  type BackupDestinationFields,
  type BackupDestinationView,
  type BackupProtocol,
} from "@hullbay/shared"
import { prisma } from "../../lib/prisma"
import { decryptBackupSecret, encryptBackupSecret } from "../auth/secrets/secret-encryption-service"
import type { StorageCapabilities } from "./storage/types"
import type { ResolvedDestination } from "./storage/registry"

/**
 * Destinations de sauvegarde.
 *
 * La config complète (identifiants inclus) est chiffrée en un seul blob AES-GCM
 * (scope "backup"). Aucune vue publique ne contient de champ secret — la
 * garantie est verrouillée par test, pas par convention.
 */

export interface CreateDestinationInput {
  name: string
  basePath: string
  projectId?: string
  config: BackupDestinationFields
}

export interface UpdateDestinationInput {
  name?: string
  basePath?: string
  config?: BackupDestinationFields
}

interface DestinationRow {
  id: string
  name: string
  protocol: string
  basePath: string
  projectId: string | null
  tenantId: string
  capabilitiesJson: Prisma.JsonValue | null
  lastTestedAt: Date | null
  createdAt: Date
  configEncrypted: string
}

const CAPABILITY_KEYS = [
  "read",
  "write",
  "delete",
  "move",
  "checksum",
  "atomicCommit",
  "serverSideEncryption",
] as const

function parseCapabilities(value: Prisma.JsonValue | null): StorageCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!CAPABILITY_KEYS.every((key) => typeof record[key] === "boolean")) return null
  return Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, record[key] as boolean]),
  ) as unknown as StorageCapabilities
}

export class BackupDestinationService {
  async create(
    input: CreateDestinationInput,
    tenantId: string,
  ): Promise<BackupDestinationView> {
    const config = BackupDestinationFieldsSchema.parse(input.config)
    if (input.projectId) await this.assertProjectInTenant(input.projectId, tenantId)

    const row = await prisma.backupDestination.create({
      data: {
        name: input.name,
        protocol: config.protocol,
        basePath: input.basePath,
        projectId: input.projectId ?? null,
        tenantId,
        configEncrypted: encryptBackupSecret(JSON.stringify(config)),
      },
    })
    return this.toView(row as DestinationRow)
  }

  async list(tenantId: string): Promise<BackupDestinationView[]> {
    const rows = await prisma.backupDestination.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    })
    return rows.map((row) => this.toView(row as DestinationRow))
  }

  async get(id: string, tenantId: string): Promise<BackupDestinationView> {
    const row = await this.findRow(id, tenantId)
    return this.toView(row)
  }

  async update(
    id: string,
    tenantId: string,
    patch: UpdateDestinationInput,
  ): Promise<BackupDestinationView> {
    await this.findRow(id, tenantId)
    const data: Prisma.BackupDestinationUpdateInput = {}
    if (patch.name !== undefined) data.name = patch.name
    if (patch.basePath !== undefined) data.basePath = patch.basePath
    if (patch.config !== undefined) {
      const config = BackupDestinationFieldsSchema.parse(patch.config)
      data.protocol = config.protocol
      data.configEncrypted = encryptBackupSecret(JSON.stringify(config))
      // Un changement de credentials invalide le dernier probe.
      data.capabilitiesJson = Prisma.DbNull
      data.lastTestedAt = null
    }
    const row = await prisma.backupDestination.update({ where: { id }, data })
    return this.toView(row as DestinationRow)
  }

  async remove(id: string, tenantId: string): Promise<void> {
    await this.findRow(id, tenantId)
    await prisma.backupDestination.delete({ where: { id } })
  }

  /** Usage interne (runner/probe) : la config déchiffrée ne sort jamais de l'API. */
  async resolve(id: string, tenantId: string): Promise<ResolvedDestination> {
    const row = await this.findRow(id, tenantId)
    const parsed = JSON.parse(decryptBackupSecret(row.configEncrypted)) as unknown
    const config = BackupDestinationFieldsSchema.parse(parsed)
    return {
      protocol: row.protocol as BackupProtocol,
      config,
      basePath: row.basePath,
      capabilities: parseCapabilities(row.capabilitiesJson),
    }
  }

  async recordProbe(
    id: string,
    tenantId: string,
    capabilities: StorageCapabilities,
  ): Promise<BackupDestinationView> {
    await this.findRow(id, tenantId)
    const row = await prisma.backupDestination.update({
      where: { id },
      data: {
        capabilitiesJson: capabilities as unknown as Prisma.InputJsonValue,
        lastTestedAt: new Date(),
      },
    })
    return this.toView(row as DestinationRow)
  }

  private async findRow(id: string, tenantId: string): Promise<DestinationRow> {
    const row = await prisma.backupDestination.findFirst({ where: { id, tenantId } })
    if (!row) throw new Error("destination introuvable")
    return row as DestinationRow
  }

  private async assertProjectInTenant(projectId: string, tenantId: string): Promise<void> {
    const project = await prisma.project.findFirst({
      where: { id: projectId, tenantId },
      select: { id: true },
    })
    if (!project) throw new Error("projet introuvable pour ce tenant")
  }

  private toView(row: DestinationRow): BackupDestinationView {
    return BackupDestinationViewSchema.parse({
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      basePath: row.basePath,
      projectId: row.projectId,
      lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
      capabilities: parseCapabilities(row.capabilitiesJson),
      createdAt: row.createdAt.toISOString(),
    })
  }
}

export const backupDestinationService = new BackupDestinationService()
