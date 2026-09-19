import { clusterService } from "../modules/clusters/service";
import { DockerEngineService } from "../modules/docker-engine/service";
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../lib/concurrency";
import { serversService } from "../modules/servers/service";

/**
 * Ce job comble un manque connu de Swarm et de notre propre modèle de
 * données. Un cluster passe à l'état prêt une seule fois, au moment où son
 * tout premier manager termine son provisionnement, et rien ne réévaluait
 * plus jamais cet état ensuite. Un cluster pouvait donc rester marqué prêt
 * en base alors que sa machine était éteinte depuis des heures.
 *
 * Le job vérifie, à intervalle régulier, que chaque cluster marqué prêt
 * répond toujours et garde un quorum sain, et il gère aussi le sens
 * inverse pour un cluster défaillant qui redevient stable. Les vérifications
 * s'exécutent en parallèle, avec une limite de concurrence bornée par
 * CLUSTER_CONCURRENCY, le même mécanisme déjà utilisé par l'auto-scaler et
 * le job de purge des ressources orphelines. Sans cette limite, une
 * installation avec un grand nombre de clusters verrait le temps total du
 * passage dépasser largement l'intervalle configuré entre deux exécutions,
 * ce qui ferait s'empiler les passages les uns sur les autres et rendrait
 * les résultats obsolètes avant même d'être exploités.
 */

const CHECK_INTERVAL_MS =
  Number(process.env.CLUSTER_HEALTH_INTERVAL_MS) || 60_000;
const FAILURE_THRESHOLD =
  Number(process.env.CLUSTER_HEALTH_FAILURE_THRESHOLD) || 3;
const RECOVERY_THRESHOLD =
  Number(process.env.CLUSTER_HEALTH_RECOVERY_THRESHOLD) || 3;

const consecutiveFailures = new Map<string, number>();
const consecutiveRecoveries = new Map<string, number>();

/**
 * Réservé aux tests. Remet à zéro tout l'état mémoire du job, puisque les
 * deux cartes ci-dessus vivent au niveau du module et ne sont jamais
 * réinitialisées automatiquement entre deux tests.
 */
export function resetHealthCountersForTests(): void {
  consecutiveFailures.clear();
  consecutiveRecoveries.clear();
}

async function isClusterHealthy(clusterId: string): Promise<boolean> {
  try {
    const engine = await DockerEngineService.forCluster(clusterId);
    if (!(await engine.isSwarmActive())) return false;
    const [managers, nodes] = await Promise.all([
      engine.managerHealth(),
      engine.listNodes(),
    ]);
    if (managers.quorumOk) {
      // Profite de cette même vérification, déjà en train de parler au
      // Swarm, pour recaler ce que la base connaît de chaque serveur, plutôt
      // que d'ouvrir une deuxième connexion séparée juste pour ça.
      await serversService
        .resyncFromSwarmNodes(clusterId, nodes as never)
        .catch(() => {});
    }
    return managers.quorumOk;
  } catch {
    return false;
  }
}

type ClusterRow = {
  id: string;
  name: string;
  status: string;
  dockerHost: string;
};

/**
 * Traite un seul cluster. Isolée dans sa propre fonction pour pouvoir être
 * distribuée par runWithConcurrency, qui borne le nombre d'exécutions
 * simultanées plutôt que de toutes les lancer d'un coup ou de les enchaîner
 * une par une.
 */
async function checkOneCluster(cluster: ClusterRow): Promise<void> {
  const wasReady = cluster.status === "ready";
  const canAttemptRecovery =
    cluster.status === "failed" && Boolean(cluster.dockerHost);

  if (!wasReady && !canAttemptRecovery) {
    consecutiveFailures.delete(cluster.id);
    consecutiveRecoveries.delete(cluster.id);
    return;
  }

  const healthy = await isClusterHealthy(cluster.id);

  if (wasReady) {
    if (healthy) {
      consecutiveFailures.delete(cluster.id);
      return;
    }
    const failures = (consecutiveFailures.get(cluster.id) ?? 0) + 1;
    consecutiveFailures.set(cluster.id, failures);
    if (failures >= FAILURE_THRESHOLD) {
      const changed = await clusterService.markUnhealthy(cluster.id);
      if (changed) {
        console.warn(
          `Le cluster ${cluster.name} (${cluster.id}) est injoignable depuis ${failures} vérifications consécutives, il passe en échec.`,
        );
      }
      consecutiveFailures.delete(cluster.id);
    }
    return;
  }

  if (!healthy) {
    consecutiveRecoveries.delete(cluster.id);
    return;
  }
  const recoveries = (consecutiveRecoveries.get(cluster.id) ?? 0) + 1;
  consecutiveRecoveries.set(cluster.id, recoveries);
  if (recoveries >= RECOVERY_THRESHOLD) {
    const changed = await clusterService.markRecovered(cluster.id);
    if (changed) {
      console.info(
        `Le cluster ${cluster.name} (${cluster.id}) répond de nouveau depuis ${recoveries} vérifications consécutives, il repasse en service.`,
      );
    }
    consecutiveRecoveries.delete(cluster.id);
  }
}

/** Un passage complet sur tous les clusters, exporté séparément pour pouvoir être testé sans dépendre du minuteur. */
export async function runClusterHealthCheck(): Promise<void> {
  await clusterService.reclaimStuckDeletions().catch((err) => {
    console.error(
      `[cluster-health] échec de la reprise des suppressions bloquées : ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  const clusters = await clusterService.list();
  if (clusters.length === 0) return;

  const { totalMs } = await runWithConcurrency(
    clusters,
    CLUSTER_CONCURRENCY,
    (cluster) => checkOneCluster(cluster),
  );

  console.debug(
    `[cluster-health] ${clusters.length} clusters vérifiés en ${totalMs.toFixed(0)}ms (concurrence maximale : ${CLUSTER_CONCURRENCY})`,
  );
}

export function startClusterHealthJob(): NodeJS.Timeout {
  return setInterval(() => {
    void runClusterHealthCheck();
  }, CHECK_INTERVAL_MS);
}
