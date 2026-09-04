import { DockerEngineService } from "../modules/docker-engine/service"
import { prisma } from "../lib/prisma"
import { eventBus } from "../lib/event-bus"
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../lib/concurrency"

/**
 * Health-check périodique des clusters.
 *
 * Le statut d'un cluster n'était évalué qu'au provisioning (markReady/markFailed,
 * une seule fois). Si un Swarm tombe ensuite (perte de quorum, manager down, socket
 * mort), aucun job ne le détectait → la route deploy pouvait lancer des workflows
 * voués à l'échec. Ce job réévalue régulièrement chaque cluster "ready" : un Swarm
 * inactif ou un quorum perdu comptent comme "dégradé". Après un nombre consécutif
 * d'observations dégradées (DEGRADE_THRESHOLD), le cluster repasse en "failed" et
 * la garde deploy (routes.ts) refuse les nouveaux déploiements jusqu'à récupération.
 * Le seuil évite de rétrograder un cluster sain sur une simple erreur transitoire.
 */

const HEALTH_INTERVAL_MS = Number(process.env.CLUSTER_HEALTH_INTERVAL_MS || 30_000)

/**
 * Nombre de ticks CONSÉCUTIFS où un cluster est vu dégradé (swarm inactif ou
 * quorum perdu) avant de le passer en "failed". Un seul échec peut être une
 * erreur réseau transitoire sur le tunnel/socket (isSwarmActive renvoie false
 * sur toute erreur) : on exige plusieurs observations avant de rétrograder,
 * pour ne pas frapper un cluster sain d'une fausse panne irréversible.
 */
const DEGRADE_THRESHOLD = Number(process.env.CLUSTER_HEALTH_DEGRADED_THRESHOLD || 3)

// clusterId -> compteur d'échelons consécutifs.
const consecutiveDegraded = new Map<string, number>()

// Garde anti-réentrance : un tick ne doit pas chevaucher le précédent.
let running = false

/** Remet un cluster "ready" en "failed" avec un événement d'audit cohérent.
 *  Retourne `true` si la rétrogradation a eu lieu, `false` si le cluster
 *  n'était plus "ready" (déjà rétrogradé/supprimé entre-temps). */
async function downgradeCluster(clusterId: string, reason: string): Promise<boolean> {
  try {
    await prisma.cluster.update({
      where: { id: clusterId, status: "ready" },
      data: { status: "failed" },
    })
  } catch {
    return false
  }
  await eventBus
    .emit("cluster.status", {
      clusterId,
      from: "ready",
      to: "failed",
      reason,
      timestamp: new Date().toISOString(),
    })
    .catch(() => {})
  return true
}

/** Un tick de santé sur tous les clusters prêts. */
export async function runClusterHealth(): Promise<void> {
  if (running) return
  running = true
  try {
    const clusters = await prisma.cluster.findMany({
      where: { status: "ready" },
      select: { id: true },
    })
    const { items } = await runWithConcurrency(
      clusters.map((c) => c.id),
      CLUSTER_CONCURRENCY,
      (clusterId) => clusterHealthForCluster(clusterId),
    )
    for (const it of items) {
      if (it.status === "rejected") {
        // un cluster injoignable ne doit pas bloquer le tick des autres.
        console.warn(
          `[cluster-health] cluster ${clusters[it.index]!.id} injoignable: ${String(it.reason)}`,
        )
      }
    }
  } finally {
    running = false
  }
}

async function clusterHealthForCluster(clusterId: string): Promise<void> {
  const engine = await DockerEngineService.forCluster(clusterId)
  const degraded = await isDegraded(engine)
  if (!degraded) {
    // Sain : reset le compteur d'échelons consécutifs.
    consecutiveDegraded.delete(clusterId)
    return
  }
  const tries = (consecutiveDegraded.get(clusterId) ?? 0) + 1
  if (tries < DEGRADE_THRESHOLD) {
    console.warn(
      `[cluster-health] cluster ${clusterId} dégradé ${tries}/${DEGRADE_THRESHOLD} — pas encore rétrogradé`,
    )
    consecutiveDegraded.set(clusterId, tries)
    return
  }
  console.warn(
    `[cluster-health] cluster ${clusterId} dégradé ${tries} ticks consécutifs → failed`,
  )
  consecutiveDegraded.delete(clusterId)
  const ok = await downgradeCluster(clusterId, "degraded")
  if (!ok) {
    console.warn(
      `[cluster-health] cluster ${clusterId} déjà rétrogradé entre-temps, event ignoré`,
    )
  }
}

/** true si le cluster est dégradé (swarm inactif ou quorum perdu). */
async function isDegraded(engine: DockerEngineService): Promise<boolean> {
  if (!(await engine.isSwarmActive())) return true
  const health = await engine.managerHealth()
  return !health.quorumOk
}

/** Démarre la boucle périodique de santé des clusters. */
export function startClusterHealthJob(): NodeJS.Timeout {
  return setInterval(() => {
    void runClusterHealth()
  }, HEALTH_INTERVAL_MS)
}
