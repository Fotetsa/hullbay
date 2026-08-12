import { prisma } from "../../lib/prisma"

/**
 * CRUD des serveurs du cluster. Le provisioning réel (SSH) est fait par le
 * workflow provision-server ; ce service ne fait que la persistance.
 * RAPPEL : privateKeyEnc = clé-OUTIL chiffrée. La clé/password PERSO de
 * l'utilisateur n'est JAMAIS persistée (mémoire seule pendant le provisioning).
 */
export class ServersService {
  // Colonnes sûres à exposer — JAMAIS privateKeyEnc/publicKey/hostKeyFp.
  private static readonly SAFE_SELECT = {
    id: true,
    name: true,
    host: true,
    port: true,
    user: true,
    role: true,
    status: true,
    swarmNodeId: true,
    lastError: true,
    createdAt: true,
    clusterId: true,
  } as const

  /** Liste exposable au client (secrets exclus). */
  list() {
    return prisma.server.findMany({
      orderBy: { createdAt: "asc" },
      select: ServersService.SAFE_SELECT,
    })
  }

  /** Récupération exposable au client (secrets exclus). */
  get(id: string) {
    return prisma.server.findUnique({ where: { id }, select: ServersService.SAFE_SELECT })
  }

  /** Usage INTERNE uniquement (provisioning/maintenance) — inclut les secrets. */
  getInternal(id: string) {
    return prisma.server.findUnique({ where: { id } })
  }

  /** Y a-t-il déjà un manager ? (le 1er serveur devient manager). */
  async hasManager(clusterId: string): Promise<boolean> {
    const m = await prisma.server.findFirst({ where: { role: "manager", status: "ready", clusterId } })
    return !!m
  }

  create(data: {
    name: string
    host: string
    port: number
    user: string
    role: string
    clusterId: string
  }) {
    return prisma.server.create({ data: { ...data, status: "provisioning" } })
  }

  update(id: string, data: Record<string, unknown>) {
    return prisma.server.update({ where: { id }, data })
  }

  remove(id: string) {
    return prisma.server.delete({ where: { id } })
  }
}

export const serversService = new ServersService()
