import { clusterService } from "../modules/clusters/service";
import { DockerEngineService } from "../modules/docker-engine/service";

/**
 * Ce job comble un manque connu de Swarm et de notre propre modèle de
 * données. Un cluster passe à l'état prêt une seule fois, au moment où son
 * tout premier manager termine son provisionnement, et rien ne réévaluait
 * plus jamais cet état ensuite. Un cluster pouvait donc rester marqué prêt
 * en base alors que sa machine était éteinte depuis des heures, ce qui
 * laissait l'utilisateur découvrir le problème seulement au moment d'un
 * déploiement raté, au lieu d'être prévenu à l'avance.
 *
 * Le job vérifie, à intervalle régulier, que chaque cluster marqué prêt
 * répond toujours et garde un quorum sain. On tolère plusieurs échecs
 * consécutifs avant d'agir, pour ne pas basculer un cluster parfaitement
 * valide en échec à cause d'un simple accroc réseau passager.
 *
 * Le job gère aussi le sens inverse. Un cluster marqué défaillant, mais qui
 * avait déjà été opérationnel par le passé et possède donc une vraie
 * adresse de connexion, peut redevenir prêt tout seul s'il répond de
 * nouveau de façon stable. On ne tente jamais cette remise en service pour
 * un cluster qui a échoué dès son tout premier provisionnement, celui-là
 * n'a jamais eu d'adresse de connexion valide, il n'y a donc rien de réel à
 * réessayer de joindre, sa seule sortie possible est un nouveau
 * provisionnement manuel. La remise en service exige, comme le passage en
 * échec, plusieurs vérifications positives consécutives avant d'agir. Et
 * dans les deux sens, l'écriture en base est conditionnelle, elle ne
 * change réellement le statut que s'il correspond encore exactement à ce
 * qu'on vient d'observer, ce qui évite de venir contredire une action que
 * l'utilisateur aurait lancée entre-temps, comme la suppression de ce même
 * cluster.
 */

const CHECK_INTERVAL_MS =
  Number(process.env.CLUSTER_HEALTH_INTERVAL_MS) || 60_000;
const FAILURE_THRESHOLD =
  Number(process.env.CLUSTER_HEALTH_FAILURE_THRESHOLD) || 3;
const RECOVERY_THRESHOLD =
  Number(process.env.CLUSTER_HEALTH_RECOVERY_THRESHOLD) || 3;

const consecutiveFailures = new Map<string, number>();
const consecutiveRecoveries = new Map<string, number>();

export function resetHealthCountersForTests(): void {
  consecutiveFailures.clear();
  consecutiveRecoveries.clear();
}

async function isClusterHealthy(clusterId: string): Promise<boolean> {
  try {
    const engine = await DockerEngineService.forCluster(clusterId);
    if (!(await engine.isSwarmActive())) return false;
    const managers = await engine.managerHealth();
    return managers.quorumOk;
  } catch {
    return false;
  }
}

/**
 * Un passage complet sur tous les clusters, exporté séparément pour pouvoir être testé sans dépendre du minuteur.
 */
export async function runClusterHealthCheck(): Promise<void> {
  const clusters = await clusterService.list();

  for (const cluster of clusters) {
    const wasReady = cluster.status === "ready";
    const canAttemptRecovery =
      cluster.status === "failed" && Boolean(cluster.dockerHost);

    // Un cluster en attente, en cours de suppression, ou en échec sans
    // jamais avoir eu d'adresse de connexion valide, ne nous concerne pas
    // ici. On efface aussi tout reliquat de compteur le concernant, pour ne
    // pas garder en mémoire l'historique d'un cluster qui n'a plus de sens
    // à surveiller dans cet état.
    if (!wasReady && !canAttemptRecovery) {
      consecutiveFailures.delete(cluster.id);
      consecutiveRecoveries.delete(cluster.id);
      continue;
    }

    const healthy = await isClusterHealthy(cluster.id);

    if (wasReady) {
      if (healthy) {
        consecutiveFailures.delete(cluster.id);
        continue;
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
      continue;
    }

    // À partir d'ici, on est dans le cas d'une tentative de remise en service.
    if (!healthy) {
      consecutiveRecoveries.delete(cluster.id);
      continue;
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
}

export function startClusterHealthJob(): NodeJS.Timeout {
  return setInterval(() => {
    void runClusterHealthCheck();
  }, CHECK_INTERVAL_MS);
}
