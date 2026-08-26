import { DockerEngineService } from "../modules/docker-engine/service";
import { serversService } from "../modules/servers/service";
import { prisma } from "../lib/prisma";
import { eventBus } from "../lib/event-bus";

/**
 * Teadown réel d'un cluster en cours de suppresion (déclanché par 
 * le subscriber centralisé sur cluster.delete.requested)
 * 
 * Pour chaque serveur : drain + remove du noeud swarm (même primitive que 
 * DELETE /api/servers/:id). Un noeud injoignable ne bloque pas le teardown des autres ni la 
 * suppression finale en base, le cluster est de toute façon abandonné, donc mieux vaut nettoyer
 * ce qu'on peut que de rester bloqué indefiniment sur un noeud mort.
 */

export async function teardownClusterWorkflow(clusterId: string, serverIds: string[]): Promise<void> {
    const errors: string[] = []

    for (const serverId of serverIds) {
        try {
            const server = await serversService.getInternal(serverId)
            if (!server) continue
            if (server.swarmNodeId) {
                const engine = await DockerEngineService.forCluster(clusterId)
                await engine.drainNode(server.swarmNodeId).catch(() => { })
                await engine.removeNode(server.swarmNodeId).catch(() => {})
            }
        } catch (err) {
            errors.push(`${serverId}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    /**
     * Suppresion DB finale, atomique, aprés la tentative de teardown infra, jamais avant
     * sinon aucun moyen de retrouver quels serveurs appartenaient à ce cluster si le teardown 
     * avait besoin d'un retry
     */
    await prisma.$transaction(async (tx) => {
        await tx.server.deleteMany({ where: { clusterId } })
        await tx.cluster.delete({ where: { id: clusterId } })
    })

    await eventBus.emit("cluster.delete.finished", { clusterId, errors })
}