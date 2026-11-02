import { randomUUID } from "node:crypto"
import type { BackupPolicyInput } from "@hullbay/shared"
import { prisma } from "../../lib/prisma"
import { DockerEngineService } from "../docker-engine/service"
import { backupDestinationService } from "./destinations.service"
import { backupTargetService } from "./targets.service"
import { getStrategy } from "./strategies/registry"
import { BackupLifecycle } from "./engine/lifecycle"
import { prismaRunStore } from "./engine/run-store"
import { acquireLease, releaseLease } from "./engine/lease"
import { backupSemaphore } from "./engine/concurrency"
import { SwarmBackupRunner } from "./runner"
import { SwarmStorageProvider } from "./storage/swarm-provider"
import { probeDestination } from "./storage/swarm-probe"

/**
 * Policies de sauvegarde : intention (cible + destination + planification).
 *
 * Les règles métier vivent ici, pas dans les routes : cohérence
 * stratégie/cible, placement obligatoire pour SMB, refus du tar sur une base.
 */

const RUNNER_IMAGE =
  process.env.BACKUP_RUNNER_IMAGE ?? "ghcr.io/fotetsa/hullbay/backup-runner:latest"

export class BackupPolicyService {
  async create(input: BackupPolicyInput, tenantId: string) {
    const target = await this.findTarget(input.targetId, tenantId)
    const destination = await this.findDestination(input.destinationId, tenantId)
    const strategy = getStrategy(input.strategyId)

    if (strategy.targetKind !== target.kind) {
      throw new Error(
        `stratégie ${strategy.id} incompatible avec une cible ${target.kind}`,
      )
    }
    if (destination.protocol === "smb" && !input.placement) {
      throw new Error(
        "une destination SMB exige une contrainte de placement (NAS joignable depuis un nœud précis)",
      )
    }

    return prisma.backupPolicy.create({
      data: {
        targetId: input.targetId,
        destinationId: input.destinationId,
        strategyId: input.strategyId,
        schedule: input.schedule,
        scheduleHourUtc: input.scheduleHourUtc ?? null,
        retentionDays: input.retentionDays,
        verification: input.verification,
        encryptionMode: input.encryptionMode,
        placementJson: input.placement ?? undefined,
        timeoutSec: input.timeoutSec,
        maxConcurrency: input.maxConcurrency,
        enabled: input.enabled,
      },
    })
  }

  async list(tenantId: string, targetId?: string) {
    const rows = await prisma.backupPolicy.findMany({
      where: {
        target: { tenantId },
        ...(targetId ? { targetId } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: { target: { select: { name: true, kind: true } } },
    })
    return rows.map((row) => ({
      ...row,
      targetName: row.target.name,
      targetKind: row.target.kind,
      target: undefined,
    }))
  }

  async get(id: string, tenantId: string) {
    const row = await prisma.backupPolicy.findFirst({
      where: { id, target: { tenantId } },
    })
    if (!row) throw new Error("policy de sauvegarde introuvable")
    return row
  }

  async update(id: string, tenantId: string, patch: Partial<BackupPolicyInput>) {
    const current = await this.get(id, tenantId)
    if (patch.destinationId) {
      const destination = await this.findDestination(patch.destinationId, tenantId)
      if (destination.protocol === "smb" && !(patch.placement ?? current.placementJson)) {
        throw new Error("une destination SMB exige une contrainte de placement")
      }
    }
    if (patch.strategyId) {
      const target = await this.findTarget(current.targetId, tenantId)
      const strategy = getStrategy(patch.strategyId)
      if (strategy.targetKind !== target.kind) {
        throw new Error(`stratégie ${strategy.id} incompatible avec une cible ${target.kind}`)
      }
    }
    return prisma.backupPolicy.update({
      where: { id },
      data: {
        ...(patch.destinationId ? { destinationId: patch.destinationId } : {}),
        ...(patch.strategyId ? { strategyId: patch.strategyId } : {}),
        ...(patch.schedule ? { schedule: patch.schedule } : {}),
        ...(patch.scheduleHourUtc !== undefined
          ? { scheduleHourUtc: patch.scheduleHourUtc }
          : {}),
        ...(patch.retentionDays !== undefined
          ? { retentionDays: patch.retentionDays }
          : {}),
        ...(patch.verification ? { verification: patch.verification } : {}),
        ...(patch.placement !== undefined
          ? { placementJson: patch.placement }
          : {}),
        ...(patch.timeoutSec !== undefined ? { timeoutSec: patch.timeoutSec } : {}),
        ...(patch.maxConcurrency !== undefined
          ? { maxConcurrency: patch.maxConcurrency }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    })
  }

  async remove(id: string, tenantId: string): Promise<void> {
    await this.get(id, tenantId)
    await prisma.backupPolicy.delete({ where: { id } })
  }

  /** Run manuel : acquiert le lease puis exécute (résolution → task → commit). */
  async runNow(id: string, tenantId: string) {
    // Lease d'exécution : empêche un run manuel concurrent avec le scheduler
    // (ou un autre run manuel) sur la même policy. Miroir de backup-scheduler.
    const owner = `manual-${randomUUID()}`
    if (!(await acquireLease(id, { owner }))) {
      throw new Error("sauvegarde déjà en cours pour cette policy")
    }
    try {
      return await this.runScheduled(id, tenantId)
    } finally {
      await releaseLease(id, owner)
    }
  }

  /**
   * Exécution planifiée : le scheduler détient DÉJÀ le lease de la policy
   * (acquis avec son propre owner). On n'en ré-acquiert donc pas un second,
   * sinon le run échouerait systématiquement. On borne seulement la charge
   * locale via le sémaphore (reviewer #16).
   */
  async runScheduled(id: string, tenantId: string) {
    await backupSemaphore.acquire()
    try {
      return await this.runLocked(id, tenantId)
    } finally {
      backupSemaphore.release()
    }
  }

  private async runLocked(id: string, tenantId: string) {
    const policy = await this.get(id, tenantId)
    const resolvedTarget = await backupTargetService.resolve(policy.targetId, tenantId)
    const destination = await backupDestinationService.resolve(policy.destinationId, tenantId)
    const strategy = getStrategy(policy.strategyId)

    const project = await prisma.project.findUnique({
      where: { id: (await this.findTarget(policy.targetId, tenantId)).projectId },
      select: { slug: true, clusterId: true },
    })
    if (!project) throw new Error("projet de la cible introuvable")

    const engine = await DockerEngineService.forCluster(project.clusterId, undefined, tenantId)
    const placement = (policy.placementJson ?? undefined) as
      | { constraints: string[]; spreadOver: string[] }
      | undefined
    // Limites de ressources explicites (#16) : un backup peut être très coûteux
    // (CPU/RAM/IO). Plafond défensif par défaut ; une surcharge par policy
    // pourra être persistée ultérieurement via `resourcesJson`.
    const resources: { cpus: number; memMb: number } = { cpus: 1, memMb: 1024 }

    // StorageProvider = frontière de stockage réelle (reviewer #2) : le moteur
    // ne connaît que ce contrat ; rclone est l'adapter Swarm sous-jacent. Le
    // producteur reçoit ce même adapter comme `StagingSink` : il ne hardcode
    // donc plus aucune commande rclone (upload, remote-string, secrets).
    const storage = new SwarmStorageProvider(
      {
        engine,
        image: RUNNER_IMAGE,
        networkName: resolvedTarget.networkName,
        placement,
        resources,
        timeoutSec: policy.timeoutSec,
        capabilities: destination.capabilities ?? null,
      },
      destination,
    )

    const runner = new SwarmBackupRunner({
      engine,
      storage,
      image: RUNNER_IMAGE,
      networkName: resolvedTarget.networkName,
      volumeName: resolvedTarget.volumeName,
      placement,
      resources,
      timeoutSec: policy.timeoutSec,
    })

    const lifecycle = new BackupLifecycle(prismaRunStore)
    return lifecycle.execute({
      policyId: policy.id,
      targetId: policy.targetId,
      destinationId: policy.destinationId,
      projectSlug: project.slug,
      trigger: "manual",
      strategy,
      target: resolvedTarget.target,
      destination,
      producer: runner,
      provider: storage,
      verification: policy.verification === "size" ? "size" : "checksum",
    })
  }

  /** Probe de capacité (task one-shot). Persiste la matrice de capacités. */
  async testDestination(id: string, tenantId: string) {
    const destination = await backupDestinationService.resolve(id, tenantId)
    const row = await prisma.backupDestination.findFirst({
      where: { id, tenantId },
      select: { projectId: true },
    })

    const clusterId = row?.projectId
      ? (
          await prisma.project.findUnique({
            where: { id: row.projectId },
            select: { clusterId: true },
          })
        )?.clusterId
      : (
          await prisma.cluster.findFirst({
            where: { tenantId },
            select: { id: true },
          })
        )?.id
    if (!clusterId) throw new Error("aucun cluster disponible pour tester cette destination")

    const engine = await DockerEngineService.forCluster(clusterId, undefined, tenantId)
    const result = await probeDestination({ engine, image: RUNNER_IMAGE, destination })

    const caps = {
      read: Boolean(result.capabilities.read),
      write: Boolean(result.capabilities.write),
      delete: Boolean(result.capabilities.delete),
      move: Boolean(result.capabilities.move),
      checksum: Boolean(result.capabilities.checksum),
      atomicCommit: Boolean(result.capabilities.atomicCommit),
      serverSideEncryption: Boolean(result.capabilities.serverSideEncryption),
    }
    const view = await backupDestinationService.recordProbe(id, tenantId, caps)
    return { ok: result.ok, capabilities: caps, destination: view }
  }

  private async findTarget(id: string, tenantId: string) {
    const row = await prisma.backupTarget.findFirst({ where: { id, tenantId } })
    if (!row) throw new Error("cible de sauvegarde introuvable")
    return row
  }

  private async findDestination(id: string, tenantId: string) {
    const row = await prisma.backupDestination.findFirst({
      where: { id, tenantId },
      select: { id: true, protocol: true },
    })
    if (!row) throw new Error("destination introuvable")
    return row
  }
}

export const backupPolicyService = new BackupPolicyService()
