import { createServer, type Server as NetServer } from "node:net"
import { prisma } from "./prisma"
import { decryptSecret } from "../modules/auth/crypto"
import { SshSession } from "./ssh"

type TunnelEntry = {
    session: SshSession;
    server: NetServer;
    localPort: number;
    lastActivity: number
}

const tunnels = new Map<string, TunnelEntry>()

const TUNNEL_TTL_MS = Number(process.env.TUNNEL_TTL_MS) || 10 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000

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

function startCleanupInterval() {
  setInterval(() => {
    const now = Date.now();
    const inactiveTunnels: string[] = [];

    for (const [key, entry] of tunnels.entries()) {
      const age = now - entry.lastActivity;
      if (age > TUNNEL_TTL_MS) {
        inactiveTunnels.push(key);
      }
    }

    for (const key of inactiveTunnels) {
      const entry = tunnels.get(key);
      if (entry) {
        console.log(
          `[ssh-tunnel] Fermeture automatique du tunnel inactif: ${key} (inactif depuis ${Math.round((now - entry.lastActivity) / 1000)}s)`,
        );
        entry.server.close();
        entry.session.dispose();
        tunnels.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}

// Démarrer le nettoyeur au chargement du module
startCleanupInterval();

/**
 * Garatit un tunnel actif vers <clusterId>:<remotePort> (côte manager),
 * retourne le port local sur lequel se connecter (127.0.0.1:localPort).
 * Idempotent : reutilise le tunnel existant s'il est deja ouver.
 */

export async function ensureTunnel(clusterId: string, remotePort: number): Promise<number> {
    const key = tunnelKey(clusterId, remotePort)
    const existing = tunnels.get(key)
    if (existing) {
        existing.lastActivity = Date.now()
        return existing.localPort;
    }

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

                    const entry = tunnels.get(key)
                    if (entry) {
                        entry.lastActivity = Date.now()
                    }
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
            tunnels.set(key, { session, server, localPort, lastActivity: Date.now() })
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