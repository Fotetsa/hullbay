import {
  LabelKeys,
  decodeJsonLabel,
  ContainerConfigSchema,
  type ContainerConfig,
} from "@hullbay/shared"
import { DockerEngineService } from "../modules/docker-engine/service"
import { prisma } from "../lib/prisma"
import { eventBus } from "../lib/event-bus"
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../lib/concurrency"

/**
 * Auto-scaler — la brique que Swarm NE fournit PAS nativement.
 *
 * Swarm maintient un nombre FIXE de replicas (+ self-healing) mais ne scale jamais
 * selon la charge. Ce job comble le manque : pour chaque service géré dont la config
 * a `autoscale.enabled`, il lit le CPU moyen des tasks (DockerEngineService.getServiceMetrics)
 * et ajuste les replicas dans [min, max] :
 *   - CPU moyen >= scaleUpCpuPct ET replicas < max  → +1
 *   - CPU moyen <= scaleDownCpuPct ET replicas > min → -1
 *
 * Hystérésis : un seul pas (+/-1) par tick, et un cooldown par service pour éviter
 * l'oscillation (flapping). La nouvelle valeur est persistée dans la config du nœud
 * en base pour que le prochain déploiement ne réécrase pas la décision du scaler.
 *
 * LIMITE multi-nœuds : getServiceMetrics ne voit que les tasks LOCALES au manager
 * (le sock local n'expose pas les conteneurs distants). Sur cluster multi-nœuds,
 * la décision se base donc sur l'échantillon local — acceptable pour un signal de
 * charge, à raffiner (agent par nœud) si besoin. Documenté comme limite connue.
 */

const SCALE_INTERVAL_MS = Number(process.env.AUTOSCALE_INTERVAL_MS || 30_000)
const COOLDOWN_MS = Number(process.env.AUTOSCALE_COOLDOWN_MS || 90_000)

// serviceId -> timestamp du dernier scaling (cooldown anti-flapping).
const lastScaledAt = new Map<string, number>()

type RawService = {
  ID?: string
  Spec?: { Name?: string; Labels?: Record<string, string> }
}

/** Un tick d'auto-scaling sur tous les services gérés éligibles. */
export async function runAutoScale(): Promise<void> {
  const clusters = await prisma.cluster.findMany({ select: { id: true } })
  const clusterIds: string[] = clusters.map((c: { id: string }) => c.id)
  const { items, totalMs } = await runWithConcurrency(
    clusterIds,
    CLUSTER_CONCURRENCY,
    (clusterId: string) => runAutoScaleForCluster(clusterId),
  )
  for (const it of items) {
    if (it.status === "rejected") {
      // un cluster injoignable ne doit pas bloquer les autres.
      console.warn(`[auto-scaler] cluster ${clusters[it.index]!.id} injoignable: ${String(it.reason)}`)
    }
  }
  console.log(`[auto-scaler] tick ${clusters.length} clusters en ${totalMs.toFixed(0)}ms (concurrency=${CLUSTER_CONCURRENCY})`)
}

async function runAutoScaleForCluster(clusterId: string): Promise<void> {
  const engine = await DockerEngineService.forCluster(clusterId)
  if (!(await engine.isSwarmActive())) return;
  const services = (await engine.listManagedServices()) as RawService[];
  const now = Date.now();

  for (const svc of services) {
    const id = svc.ID;
    const labels = svc.Spec?.Labels ?? {};
    if (!id || labels[LabelKeys.system] === "true") continue;

    const cfg = decodeContainerSpec(labels[LabelKeys.spec]);
    const auto = cfg?.autoscale;
    if (!cfg || !auto?.enabled) continue;

    // Cooldown cle par service : un id de service est deja globalement unique 
    // dans le cluster, donc pas besoin de clusterId.
    if (now - (lastScaledAt.get(id) ?? 0) < COOLDOWN_MS) continue;

    let metrics;
    try {
      metrics = await engine.getServiceMetrics(id);
    } catch {
      continue; // service disparu entre listing et mesure
    }
    // Pas d'échantillon CPU exploitable (aucune task locale) → on ne décide pas.
    if (metrics.sampledTasks === 0) continue;

    const current = metrics.desiredReplicas;
    let target = current;
    if (metrics.avgCpuPct >= auto.scaleUpCpuPct && current < auto.maxReplicas) {
      target = current + 1;
    } else if (
      metrics.avgCpuPct <= auto.scaleDownCpuPct &&
      current > auto.minReplicas
    ) {
      target = current - 1;
    }
    if (target === current) continue;

    try {
      await engine.scaleService(id, target);
      lastScaledAt.set(id, now);
      await persistReplicas(labels[LabelKeys.nodeId], target);
      await eventBus.emit("autoscale.applied", {
        serviceId: id,
        nodeId: labels[LabelKeys.nodeId],
        projectId: labels[LabelKeys.projectId],
        from: current,
        to: target,
        avgCpuPct: metrics.avgCpuPct,
      });
    } catch {
      // échec de scaling : on réessaiera au prochain tick (pas de cooldown posé).
    }
  }
}

/** Décode et valide la config conteneur depuis le label bozando.spec (base64 JSON). */
function decodeContainerSpec(spec: string | undefined): ContainerConfig | null {
  const raw = decodeJsonLabel(spec)
  if (!raw) return null
  const parsed = ContainerConfigSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * Persiste le nouveau nombre de replicas dans la config du nœud (DB = source de
 * vérité désirée), pour qu'un futur déploiement ne réécrase pas la décision.
 * Tolérant : si le nœud n'existe pas en base, le label Docker reste la vérité.
 */
async function persistReplicas(nodeId: string | undefined, replicas: number): Promise<void> {
  if (!nodeId) return
  const node = await prisma.node.findUnique({ where: { id: nodeId } })
  if (!node) return
  const config = { ...(node.config as Record<string, unknown>), replicas }
  await prisma.node.update({ where: { id: nodeId }, data: { config } })
}

/** Démarre la boucle périodique d'auto-scaling. */
export function startAutoScaler(): NodeJS.Timeout {
  return setInterval(() => {
    void runAutoScale()
  }, SCALE_INTERVAL_MS)
}
