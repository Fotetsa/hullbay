import { Key } from '@medusajs/icons';
import { createServer, type Server as NetServer } from "node:net"
import { prisma } from "./prisma"
import { decryptSecret } from "../modules/auth/crypto"
import { SshSession } from "./ssh"

type TunnelEntry = { session: SshSession; server: NetServer; localPort: number }

const tunnels = new Map<string, TunnelEntry>()

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
 * Idempotent : reutilise le tunnel existant s'il est deja ouver.
 */

export async function ensureTunnel(clusterId: string, remotePort: number): Promise<number> {
    const key = tunnelKey(clusterId, remotePort)
    const existing = tunnels.get(key)
    if (existing) return existing.localPort

    const session = await openSessionForCluster(clusterId)

    return new Promise<number>((resolve, reject) => {
        const server = createServer((socket) => {
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

        server.on("error", (err) => {
            tunnels.delete(key)
            reject(err)
        })

        server.listen(0, "127.0.0.1", () => {
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
    if (!entry) return
    entry.server.close()
    entry.session.dispose()
    tunnels.delete(key)
}