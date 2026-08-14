import { createServer, type Server as NetServer, type Socket as NetSocket } from "node:net"
import { prisma } from "./prisma"
import { decryptSecret } from "../modules/auth/crypto"
import { SshSession } from "./ssh"

type TunnelEntry = { session: SshSession; server: NetServer; localPort: number }

const tunnels = new Map<string, TunnelEntry>()
const pendingTunnels = new Map<string, Promise<number>>()

/** Borne le connect SSH : un hôte injoignable ne doit pas empoisonner la clé
 *  (le pending resterait dans pendingTunnels et bloquerait tout nouvel essai). */
const CONNECT_TIMEOUT_MS = 15_000

function tunnelKey(clusterId: string, remotePort: number): string {
    return `${clusterId}:${remotePort}`
}

async function openSessionForCluster(clusterId: string): Promise<SshSession> {
    const manager = await prisma.server.findFirst({
        where: { clusterId, role: "manager", status: "ready" },
        orderBy: { createdAt: "asc" },
    })

    if (!manager) {
        throw new Error(`Aucun manager prêt pour le cluster ${clusterId}, tunnel impossible.`)
    }
    if (!manager.privateKeyEnc) {
        throw new Error(
          `Manager ${manager.name} sans clé de maintenance enregistrée, reprovisionner.`,
        );
    }

    return SshSession.connect({
        host: manager.host,
        port: manager.port,
        user: manager.user,
        credential: { type: "key", privateKey: decryptSecret(manager.privateKeyEnc) },
        knownHostKeyFp: manager.hostKeyFp ?? undefined,
    })
}

/**
 * Garatit un tunnel actif vers <clusterId>:<remotePort> (côte manager),
 * retourne le port local sur lequel se connecter (127.0.0.1:localPort).
 * Idempotent et atomique : les appels concurrents pour la même clé partagent
 * la même Promise de création (Map pendingTunnels) et un seul tunnel est monté.
 */

export async function ensureTunnel(clusterId: string, remotePort: number): Promise<number> {
    const key = tunnelKey(clusterId, remotePort)
    const existing = tunnels.get(key)
    if (existing) return existing.localPort

    // Création en cours pour cette clé : partage la même promesse au lieu de
    // relancer une session SSH en parallèle (évite tunnels dupliqués).
    const pending = pendingTunnels.get(key)
    if (pending) return pending

    const creating = createTunnel(clusterId, remotePort)
        .finally(() => pendingTunnels.delete(key))
    pendingTunnels.set(key, creating)
    return creating
}

async function createTunnel(clusterId: string, remotePort: number): Promise<number> {
    const key = tunnelKey(clusterId, remotePort)
    let timer: ReturnType<typeof setTimeout> | undefined
    const session = await Promise.race([
        openSessionForCluster(clusterId),
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`SSH: connexion du cluster ${clusterId} en attente (timeout ${CONNECT_TIMEOUT_MS}ms)`)),
                CONNECT_TIMEOUT_MS,
            )
        }),
    ]).finally(() => clearTimeout(timer))

    return new Promise<number>((resolve, reject) => {
        let closed = false
        let settled = false
        const sockets = new Set<NetSocket>()

        /** Ferme le serveur local + la session SSH et purge la Map. Idempotent. */
        const teardown = (cause?: Error | null) => {
            if (closed) return
            closed = true
            tunnels.delete(key)
            try { server.close() } catch { /* jamais écouté (ERR_SERVER_NOT_RUNNING) */ }
            // Les sockets locaux en attente de forwardOut sont orphelins :
            // sans ça server.close() attendrait leur fin (fuite de descripteurs).
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            // dispose() est idempotent : double-appel avec closeTunnel sans risque.
            session.dispose()
            // Session morte avant le callback de listen : ne laisse JAMAIS
            // l'appelant obtenir un port dont le tunnel est déjà détruit.
            if (!settled) reject(cause ?? new Error("Session SSH fermée avant l'écoute du tunnel."))
        }

        const server = createServer((socket) => {
            sockets.add(socket)
            socket.on("error", () => socket.destroy())
            socket.on("close", () => sockets.delete(socket))
            session
                .forwardOut("127.0.0.1", remotePort)
                .then((stream) => {
                    stream.pipe(socket)
                    socket.pipe(stream)
                    stream.on("close", () => socket.destroy())
                    socket.on("close", () => stream.destroy())
                })
            .catch(() => socket.destroy())
        })

        // Session SSH tombée (réseau, serveur distant) → nettoie tout.
        session.onClose(() => teardown())
        session.onError((err) => teardown(err))
        // Serveur local fermé (y compris via closeTunnel) → purge la Map.
        server.on("close", teardown)
        server.on("error", (err) => teardown(err))

        server.listen(0, "127.0.0.1", () => {
            // Session déjà morte pendant le listen : ne ré-ajoute pas d'entrée
            // fantôme (teardown a déjà rejeté le promise).
            if (closed) return
            settled = true
            const addr = server.address()
            const localPort = typeof addr === "object" && addr ? addr.port : 0
            tunnels.set(key, { session, server, localPort })
            resolve(localPort)
        })
    })
}

/** ferme un tunnel precis au cas où le manager deviens injoignable */
export function closeTunnel(clusterId: string, remotePort: number): void {
    const key = tunnelKey(clusterId, remotePort)
    const entry = tunnels.get(key)
    if (entry) {
        entry.server.close()
        entry.session.dispose()
        tunnels.delete(key)
        return
    }
    // Création encore en vol : la ferme dès qu'elle est montée.
    pendingTunnels.get(key)?.then(() => closeTunnel(clusterId, remotePort))
}