import { eventBus } from "../lib/event-bus";
import { invalidateDockerClient } from "../modules/docker-engine/client";
import { teardownClusterWorkflow } from "../workflows/teardown-cluster";

/**
 * Réagit aux changements d'état d'un cluster. le workflow de provisioning 
 * n'a plus besoin de connaître ce mécanique de cache, il se contente d'émettre l'event métier.
 */
export function registerClusterSubscribers(): void {
  eventBus.on("cluster.status", (evt) => {
    const { clusterId, to } = evt.data as { clusterId: string; to: string };
    invalidateDockerClient(clusterId);
    console.log(`[cluster] ${clusterId} → ${to} (cache Docker invalidé)`);
  });

  //Déclenche le teardown réel (drain + remove des noeuds Swarm), en tâche de fond.
  eventBus.on("cluster.delete.requested", (evt) => {
    const { clusterId, serverIds } = evt.data as { clusterId: string; serverIds: string[] }
    void teardownClusterWorkflow(clusterId, serverIds).catch((err) => {
      console.error(`[cluster] teardown ${clusterId} a échoué:`, err)
    })
  })
}
