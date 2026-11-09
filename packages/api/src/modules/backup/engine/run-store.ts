import type { BackupManifest, BackupRunPhase } from "@hullbay/shared"
import { prisma } from "../../../lib/prisma"
import type { RunStore, RunTrigger } from "./lifecycle"

/** Implémentation Prisma du journal d'exécution. */
export class PrismaRunStore implements RunStore {
  async createRun(policyId: string, trigger: RunTrigger): Promise<{ id: string }> {
    const run = await prisma.backupRun.create({
      data: { policyId, trigger, status: "RUNNING", phase: "resolving" },
      select: { id: true },
    })
    return { id: run.id }
  }

  async setPhase(runId: string, phase: BackupRunPhase): Promise<void> {
    await prisma.backupRun.update({ where: { id: runId }, data: { phase } })
  }

  async complete(runId: string, sizeBytes: number): Promise<void> {
    await prisma.backupRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        phase: "done",
        finishedAt: new Date(),
        sizeBytes: BigInt(sizeBytes),
      },
    })
  }

  async fail(runId: string, errorCode: string, errorMessage: string): Promise<void> {
    await prisma.backupRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 2000),
      },
    })
  }

  async createArtifact(input: {
    runId: string
    targetId: string
    destinationId: string
    storageKey: string
    manifestJson: BackupManifest
    payloadFormat: string
    checksumSha256: string
    sizeBytes: number
    engine: string
    engineVersion: string
    strategyId: string
    formatVersion: number
  }): Promise<{ id: string }> {
    const artifact = await prisma.backupArtifact.create({
      data: {
        runId: input.runId,
        targetId: input.targetId,
        destinationId: input.destinationId,
        storageKey: input.storageKey,
        manifestJson: input.manifestJson,
        payloadFormat: input.payloadFormat,
        checksumSha256: input.checksumSha256,
        sizeBytes: BigInt(input.sizeBytes),
        engine: input.engine,
        engineVersion: input.engineVersion,
        strategyId: input.strategyId,
        formatVersion: input.formatVersion,
      },
      select: { id: true },
    })
    return { id: artifact.id }
  }
}

export const prismaRunStore = new PrismaRunStore()
