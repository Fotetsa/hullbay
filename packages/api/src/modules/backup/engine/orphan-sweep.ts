import { prisma } from "../../../lib/prisma"
import { DockerEngineService } from "../../docker-engine/service"

/**
 * Nettoyage des ressources éphémères du Backup Engine (reviewer #16).
 *
 * Le runner supprime ses services/secrets dans un `finally`, mais un crash API
 * (SIGKILL, redéploiement) peut laisser des services Swarm ou des secrets
 * orphelins. Au démarrage, on supprime toute ressource backup qui n'est pas
 * rattachée à un run encore RUNNING en base — les runs d'une autre instance HA
 * (partageant la même base) sont donc préservés.
 */
export async function sweepOrphanBackupResources(
  engine: DockerEngineService,
  activeRunIds: Set<string>,
): Promise<{ services: number; secrets: number }> {
  let services = 0
  let secrets = 0

  for (const svc of await engine.listBackupServices()) {
    const runId = svc.Spec?.Labels?.["bozando.backupRunId"]
    if (runId && activeRunIds.has(runId)) continue
    const id = svc.ID ?? svc.Spec?.Name
    if (id) {
      await engine.removeService(id).catch(() => undefined)
      services += 1
    }
  }

  for (const secret of await engine.listBackupSecrets()) {
    const runId = secret.labels["bozando.backupRunId"]
    if (runId && activeRunIds.has(runId)) continue
    if (secret.name) {
      await engine.removeSecret(secret.name).catch(() => undefined)
      secrets += 1
    }
  }

  return { services, secrets }
}

/** Sweep global, cluster par cluster. Best-effort : un cluster injoignable n'arrête pas les autres. */
export async function sweepAllOrphanBackupResources(): Promise<void> {
  const running = await prisma.backupRun.findMany({
    where: { status: "RUNNING" },
    select: { id: true },
  })
  const active = new Set(running.map((run) => run.id))
  const clusters = await prisma.cluster.findMany({ select: { id: true } })

  for (const cluster of clusters) {
    try {
      const engine = await DockerEngineService.forCluster(cluster.id)
      await sweepOrphanBackupResources(engine, active)
    } catch {
      // Cluster injoignable : on réessaiera au prochain démarrage.
    }
  }
}
