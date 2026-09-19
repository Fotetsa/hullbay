import { eventBus } from "../lib/event-bus";
import { invalidateDockerClient } from "../modules/docker-engine/client";
import { teardownClusterWorkflow } from "../workflows/teardown-cluster";
import { startObserverForClusterOnDemand } from "../modules/observer/service";

/**
 * Réagit aux changements d'état d'un cluster. Le workflow de provisionnement
 * n'a plus besoin de connaître cette mécanique de cache ni de suivi en
 * direct, il se contente d'émettre l'événement métier, et c'est ici que les
 * effets de bord qui en découlent sont déclenchés.
 */
export function registerClusterSubscribers(): void {
  eventBus.on("cluster.status", (evt) => {
    const { clusterId, to } = evt.data as { clusterId: string; to: string };
    invalidateDockerClient(clusterId);
    console.log(`[cluster] ${clusterId} → ${to} (cache Docker invalidé)`);

    // Un cluster qui vient tout juste de devenir prêt, que ce soit un tout
    // nouveau provisionnement ou un rétablissement après une panne détectée
    // par le job de santé, doit immédiatement commencer à être suivi par
    // l'observateur. Sans cet appel, ce suivi n'aurait démarré qu'au
    // prochain redémarrage de l'API, laissant le canvas figé sur un état
    // périmé pour ce cluster en attendant.
    if (to === "ready") {
      startObserverForClusterOnDemand(clusterId);
    }
  });

  // Déclenche le teardown réel (drain et retrait des nœuds Swarm), en tâche de fond.
  eventBus.on("cluster.delete.requested", (evt) => {
    const { clusterId, serverIds } = evt.data as {
      clusterId: string;
      serverIds: string[];
    };
    void teardownClusterWorkflow(clusterId, serverIds).catch((err) => {
      console.error(`[cluster] teardown ${clusterId} a échoué:`, err);
    });
  });
}
