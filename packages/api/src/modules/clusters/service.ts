import { prisma } from "../../lib/prisma";
import { eventBus } from "../../lib/event-bus";
import { Prisma } from "@prisma/client";

export type ClusterStatus = "pending" | "ready" | "failed" | "deleting";

/**
 * Se module porte tout la logique métier de l'entité cluster
 */

export class ClusterService {
  list() {
    return prisma.cluster.findMany({ orderBy: { createdAt: "asc" } });
  }

  get(id: string) {
    return prisma.cluster.findUnique({ where: { id } });
  }

  getOrThrow(id: string) {
    return prisma.cluster.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Cluster systeme est auto-crée au premier appel
   */
  async getDefault() {
    const existing = await prisma.cluster.findFirst({
      where: { isDefault: true },
    });
    if (existing) return existing;
    return prisma.cluster.create({
      data: {
        name: "Default",
        dockerHost: process.env.DOCKER_HOST || "tcp://socket-proxy:2375",
        caddyAdminUrl: process.env.CADDY_ADMIN_URL || "http://caddy:2019",
        isDefault: true,
        status: "ready",
      },
    });
  }

  /**
   * Démarrage de la creation d'un nouveau cluster-etat "pending" tant que le
   * provisioning de son 1er manager n'est pas terminé
   */
  async createPending(name: string) {
    const existing = await prisma.cluster.findUnique({ where: { name } });
    if (existing) {
      if (existing.status === "ready") {
        const err = new Error(
          `un cluster nommé "${name}" existe déjà et est opérationnel — choisis un autre nom`,
        );
        (err as Error & { statusCode?: number }).statusCode = 409;
        throw err;
      }
      try {
        return await prisma.$transaction(async (tx) => {
          await tx.server.deleteMany({ where: { clusterId: existing.id } });
          await tx.cluster.delete({ where: { id: existing.id } });
          return tx.cluster.create({
            data: {
              name,
              dockerHost: "",
              caddyAdminUrl: "",
              status: "pending",
            },
          });
        });
      } catch (err) {
        throw this.friendlyNameCollisionError(err, name);
      }
    }

    try {
      return await prisma.cluster.create({
        data: { name, dockerHost: "", caddyAdminUrl: "", status: "pending" },
      });
    } catch (err) {
      throw this.friendlyNameCollisionError(err, name);
    }
  }
  private friendlyNameCollisionError(err: unknown, name: string): Error {
    if (
      (typeof (Prisma as any).PrismaClientKnownRequestError === "function" &&
        err instanceof (Prisma as any).PrismaClientKnownRequestError &&
        (err as any).code === "P2002") ||
      // In some test environments the error class may not be available to construct;
      // fall back to duck-typing the error object by its `code` property.
      (err && typeof (err as any).code === "string" && (err as any).code === "P2002")
    ) {
      const friendly = new Error(
        `un cluster nommé "${name}" vient d'être créé par une autre requête — réessaie avec un autre nom`,
      );
      (friendly as Error & { statusCode?: number }).statusCode = 409;
      return friendly;
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Finalisation d'un cluster nouvellement provisionné : persistons ses coordonnées
   * de connexion réelles et notifions les données via l'event cluster.
   */
  async markReady(
    clusterId: string,
    dockerHost: string,
    caddyAdminUrl: string,
  ): Promise<void> {
    await prisma.cluster.update({
      where: { id: clusterId },
      data: { dockerHost, caddyAdminUrl, status: "ready" },
    });
    await eventBus.emit("cluster.status", {
      clusterId,
      from: "pending",
      to: "ready",
      timestamp: new Date().toISOString(),
    });
  }

  // Marque un cluster en echec suite un provisioning qui c'est mal passé
  async markFailed(clusterId: string): Promise<void> {
    await prisma.cluster
      .update({ where: { id: clusterId }, data: { status: "failed" } })
      .catch(() => {});
    await eventBus
      .emit("cluster.status", {
        clusterId,
        from: "pending",
        to: "failed",
        timestamp: new Date().toISOString(),
      })
      .catch(() => {});
  }

  /**
   * Supprimer un cluster non opérationnel (pending/failed uniquement)
   * Aucun serveur rattaché: suppresion DB immédiate et synchrone (rien a teardown, aucun risque)
   *
   * Au moins un serveur rattaché : ces serveur peuvent avoir réellement rejoint un Swarm. Sans
   * confirmation explicite (opts.teardown), on refuse (409)plutôt que de supprimer
   * silencieusement des enregistrements pointant vers des ressources réelles encore actives.
   * Si treardown = true on en touche a aucune ligne DB ici on marque juste l'intention (status = "deleting")
   * et on émet cluster.delete.requested. Le vrai teardown est de fait de façon asynchrone par
   * teardownClusterWorkflow (cf. workflows/teardown-cluster.ts) déclenché par le subscriber
   * centralisé.
   */
  async remove(
    id: string,
    opts: { teardown?: boolean } = {},
  ): Promise<{
    removedServers: number;
    status: "deleted" | "deleting";
  }> {
    const cluster = await this.get(id);
    if (!cluster) {
      const err = new Error("cluster introuvable");
      (err as Error & { statusCode?: number }).statusCode = 404;
      throw err;
    }
    if (cluster.isDefault) {
      const err = new Error(
        "le cluster par défaut ne peut jamais être supprimé",
      );
      (err as Error & { statusCode?: number }).statusCode = 403;
      throw err;
    }
    if (cluster.status === "ready") {
      const err = new Error(
        "impossible de supprimer un cluster opérationnel — retire d'abord ses serveurs",
      );
      (err as Error & { statusCode?: number }).statusCode = 409;
      throw err;
    }
    if (cluster.status === "deleting") {
      const err = new Error("Suppression déjà en cours pour ce cluster");
      (err as Error & { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const servers = await prisma.server.findMany({
      where: { clusterId: id },
      select: { id: true },
    });

    if (servers.length === 0) {
      await prisma.cluster.delete({ where: { id } });
      return { removedServers: 0, status: "deleted" };
    }

    if (!opts.teardown) {
      const err = new Error(
        `${servers.length} serveur(s) rattaché(s) à ce cluster — confirme le teardown pour les détruire, ou retire-les manuellement d'abord.`,
      );
      (err as Error & { statusCode?: number }).statusCode = 409;
      throw err;
    }

    await prisma.cluster.update({
      where: { id },
      data: { status: "deleting" },
    });
    await eventBus.emit("cluster.delete.requested", {
      clusterId: id,
      serverIds: servers.map((s) => s.id),
    });

    return { removedServers: servers.length, status: "deleting" };
  }
}

export const clusterService = new ClusterService();
