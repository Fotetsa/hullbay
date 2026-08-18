import { eventBus } from "../../lib/event-bus";
import { invalidateDockerClient } from "../docker-engine/client";

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
}
