import os from "node:os"
import { prisma } from "../lib/prisma"
import { backupPolicyService } from "../modules/backup/policies.service"
import { backupDestinationService } from "../modules/backup/destinations.service"
import { backupTargetService } from "../modules/backup/targets.service"
import { runRetention } from "../modules/backup/retention"
import { acquireLease, releaseLease } from "../modules/backup/engine/lease"
import { sweepAllOrphanBackupResources } from "../modules/backup/engine/orphan-sweep"
import { DockerEngineService } from "../modules/docker-engine/service"

/**
 * Scheduler de sauvegarde (motif `setInterval` des 3 jobs existants).
 *
 * Deux garanties :
 *  - lease en base : deux instances Hullbay ne lancent jamais le même backup ;
 *  - rétention uniquement APRÈS un run commité (jamais sur échec).
 */

const RUNNER_IMAGE =
  process.env.BACKUP_RUNNER_IMAGE ?? "ghcr.io/fotetsa/hullbay/backup-runner:latest"

export interface PolicySchedule {
  schedule: string
  scheduleHourUtc: number | null
  enabled: boolean
}

/** Détermine si une policy doit s'exécuter maintenant (logique pure). */
export function isPolicyDue(
  policy: PolicySchedule,
  lastRunAt: Date | null,
  now: Date,
): boolean {
  if (!policy.enabled || policy.schedule === "manual") return false
  const hour = policy.scheduleHourUtc ?? 2
  if (now.getUTCHours() < hour) return false

  if (policy.schedule === "daily") {
    if (!lastRunAt) return true
    return lastRunAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)
  }
  if (policy.schedule === "weekly") {
    if (!lastRunAt) return true
    return now.getTime() - lastRunAt.getTime() >= 7 * 24 * 60 * 60 * 1000
  }
  return false
}

const OWNER = `${os.hostname()}-${process.pid}`

export async function runSchedulerTick(now = new Date()): Promise<{
  ran: number
  skipped: number
  failed: number
}> {
  const policies = await prisma.backupPolicy.findMany({
    where: { enabled: true, schedule: { not: "manual" } },
    select: {
      id: true,
      schedule: true,
      scheduleHourUtc: true,
      enabled: true,
      retentionDays: true,
      timeoutSec: true,
      destinationId: true,
      targetId: true,
      target: { select: { tenantId: true, name: true, project: { select: { slug: true } } } },
    },
  })

  let ran = 0
  let skipped = 0
  let failed = 0

  for (const policy of policies) {
    const lastRun = await prisma.backupRun.findFirst({
      where: { policyId: policy.id },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    })

    if (!isPolicyDue(policy, lastRun?.startedAt ?? null, now)) continue

    const tenantId = policy.target.tenantId
    if (!(await acquireLease(policy.id, { owner: OWNER }))) {
      skipped += 1
      continue
    }

    try {
      // Le scheduler détient déjà le lease (OWNER) : ne pas en ré-acquérir un
      // second dans runNow (ce qui échouerait toujours). `runScheduled` exécute
      // sous ce lease et ne fait que borner la concurrence locale.
      const result = await backupPolicyService.runScheduled(policy.id, tenantId)
      if (!result.ok) {
        failed += 1
        continue
      }
      ran += 1

      // Rétention : uniquement après un artifact commité.
      try {
        const destination = await backupDestinationService.resolve(
          policy.destinationId,
          tenantId,
        )
        const project = await prisma.project.findFirst({
          where: { backupTargets: { some: { id: policy.targetId } } },
          select: { slug: true, clusterId: true },
        })
        if (project) {
          const engine = await DockerEngineService.forCluster(
            project.clusterId,
            undefined,
            tenantId,
          )
          await runRetention({
            engine,
            image: RUNNER_IMAGE,
            destination,
            scope: {
              basePath: destination.basePath,
              projectSlug: project.slug,
              targetName: policy.target.name,
              retentionDays: policy.retentionDays,
            },
            timeoutSec: policy.timeoutSec,
          })
        }
      } catch (error) {
        // Une rétention ratée ne remet jamais en cause le backup déjà commité.
        console.warn(
          `[backup] rétention ignorée pour ${policy.id}:`,
          error instanceof Error ? error.message : error,
        )
      }
    } finally {
      await releaseLease(policy.id, OWNER)
    }
  }

  return { ran, skipped, failed }
}

/** Marque FAILED les runs bloqués (API tuée pendant un task). */
export async function sweepStaleRuns(olderThanMs = 3 * 60 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs)
  const result = await prisma.backupRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      errorCode: "stale_run",
      errorMessage: "run interrompu (API arrêtée ou task perdu)",
      finishedAt: new Date(),
    },
  })
  return result.count
}

let timer: NodeJS.Timeout | undefined

export function startBackupScheduler(intervalMs = 60_000): void {
  if (timer) return
  // Marque les runs interrompus comme FAILED, PUIS purge les services/secrets
  // orphelins (crash API) — reviewer #16.
  void sweepStaleRuns()
    .then(() => sweepAllOrphanBackupResources())
    .catch(() => undefined)
  timer = setInterval(() => {
    void runSchedulerTick().catch((error) => {
      console.error("[backup] tick échoué:", error)
    })
  }, intervalMs)
}

export function stopBackupScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
