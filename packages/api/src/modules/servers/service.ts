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
    systemInfo: true,
  } as const;

  /** Liste exposable au client (secrets exclus). */
  list() {
    return prisma.server.findMany({
      orderBy: { createdAt: "asc" },
      select: ServersService.SAFE_SELECT,
    });
  }

  /** Récupération exposable au client (secrets exclus). */
  get(id: string) {
    return prisma.server.findUnique({
      where: { id },
      select: ServersService.SAFE_SELECT,
    });
  }

  /** Usage INTERNE uniquement (provisioning/maintenance) — inclut les secrets. */
  getInternal(id: string) {
    return prisma.server.findUnique({ where: { id } });
  }

  /** Y a-t-il déjà un manager ? (le 1er serveur devient manager). */
  async hasManager(clusterId: string): Promise<boolean> {
    const m = await prisma.server.findFirst({
      where: { role: "manager", status: "ready", clusterId },
    });
    return !!m;
  }

  /**
   * Compte les managers réellement actifs, c'est-à-dire avec le rôle manager
   * et le statut ready, pour un cluster donné. Sert à empêcher qu'on retire
   * le dernier manager restant, ce qui couperait le control plane du cluster
   * sans qu'on puisse plus jamais revenir en arrière depuis l'interface.
   */
  async countReadyManagers(clusterId: string): Promise<number> {
    return prisma.server.count({
      where: { role: "manager", status: "ready", clusterId },
    });
  }

  /**
   * Recale le rôle, l'état de joignabilité, et l'identifiant Swarm de chaque
   * serveur connu d'un cluster, d'après ce que le Swarm rapporte réellement en
   * ce moment précis. Sans ce recalage, une promotion faite hors interface, un
   * nœud retiré directement en ligne de commande, ou une machine simplement
   * tombée, ne se refléteraient jamais dans la base, alors que cette même
   * base sert justement à décider qui peut encore agir comme manager et où
   * pointer le tunnel de connexion.
   */
  async resyncFromSwarmNodes(
    clusterId: string,
    nodes: Array<{
      ID?: string;
      Status?: { Addr?: string; State?: string };
      Spec?: { Role?: string };
      Description?: { Hostname?: string };
    }>,
  ): Promise<void> {
    const servers = await prisma.server.findMany({ where: { clusterId } });
    for (const server of servers) {
      // Un serveur encore en cours de provisionnement n'a pas de raison
      // d'apparaître dans cette liste, on ne le touche jamais ici.
      if (server.status === "provisioning") continue;

      const match = nodes.find(
        (n) =>
          n.Status?.Addr === server.host ||
          n.Description?.Hostname === server.host,
      );
      if (!match) continue;

      const swarmRole = match.Spec?.Role === "manager" ? "manager" : "worker";
      const reachable = match.Status?.State === "ready";
      const newStatus = reachable ? "ready" : "down";

      const data: Record<string, unknown> = {};
      if (match.ID && match.ID !== server.swarmNodeId)
        data.swarmNodeId = match.ID;
      if (swarmRole !== server.role) data.role = swarmRole;
      if (newStatus !== server.status) data.status = newStatus;

      if (Object.keys(data).length > 0) {
        await prisma.server
          .update({ where: { id: server.id }, data })
          .catch((err) => {
            console.error(
              `[servers] impossible de resynchroniser le serveur ${server.id} : ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    }
  }

  create(data: {
    name: string;
    host: string;
    port: number;
    user: string;
    role: string;
    clusterId: string;
  }) {
    return prisma.server.create({ data: { ...data, status: "provisioning" } });
  }

  update(id: string, data: Record<string, unknown>) {
    return prisma.server.update({ where: { id }, data });
  }

  remove(id: string) {
    return prisma.server.delete({ where: { id } });
  }
}

export const serversService = new ServersService()
