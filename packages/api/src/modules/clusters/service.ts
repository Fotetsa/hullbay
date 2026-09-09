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
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
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

  /**
   * Marque un cluster en échec suite à un provisioning qui s'est mal passé.
   * On ne relance jamais d'exception ici, cette fonction est appelée en toute
   * fin de workflow, souvent depuis un bloc qui gère déjà une erreur précédente,
   * et on ne veut surtout pas en masquer une nouvelle derrière. En revanche,
   * on ne doit plus jamais avaler un échec de la mise à jour en base sans rien
   * dire. Sans cette visibilité, un cluster resterait bloqué indéfiniment dans
   * un état incohérent, sans que personne ne puisse s'en rendre compte.
   */
  async markFailed(clusterId: string): Promise<void> {
    try {
      await prisma.cluster.update({
        where: { id: clusterId },
        data: { status: "failed" },
      });
    } catch (err) {
      console.error(
        `[clusters] impossible de marquer le cluster ${clusterId} comme failed :`,
        err,
      );
      throw err;
    }
    try {
      await eventBus.emit("cluster.status", {
        clusterId,
        from: "pending",
        to: "failed",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[clusters] échec emit cluster.status pour ${clusterId} : ${errMsg}`);
    }
  }

  /**
   * Fait passer un cluster de l'état prêt à l'état défaillant, mais seulement
   * s'il est encore réellement dans l'état prêt au moment précis de l'écriture.
   * On utilise une mise à jour conditionnelle directement portée par la
   * requête, plutôt qu'une lecture suivie d'une écriture séparée, pour ne
   * jamais risquer d'agir sur une information déjà périmée, par exemple si
   * l'utilisateur avait entre-temps lancé une action sur ce même cluster.
   * Retourne vrai si la transition a réellement eu lieu, faux si elle a été
   * annulée parce que l'état avait déjà changé sous nos pieds.
   */
  async markUnhealthy(clusterId: string): Promise<boolean> {
    let changed = false;
    try {
      const result = await prisma.cluster.updateMany({
        where: { id: clusterId, status: "ready" },
        data: { status: "failed" },
      });
      changed = result.count > 0;
    } catch (err) {
      console.error(
        `Impossible de marquer le cluster ${clusterId} comme défaillant :`,
        err,
      );
      return false;
    }
    if (!changed) return false;
    try {
      await eventBus.emit("cluster.status", {
        clusterId,
        from: "ready",
        to: "failed",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `Impossible d'émettre l'événement de statut pour ${clusterId} :`,
        err,
      );
    }
    return true;
  }

  /**
   * Fait passer un cluster précédemment marqué défaillant de nouveau vers
   * l'état prêt, après que le job de surveillance a constaté qu'il répondait
   * à nouveau de façon stable. Même principe de mise à jour conditionnelle
   * que markUnhealthy, on ne touche à rien si le cluster n'est plus, au
   * moment de l'écriture, dans l'état défaillant qu'on croyait observer, ce
   * qui couvre notamment le cas où une suppression aurait démarré entre-temps.
   */
  async markRecovered(clusterId: string): Promise<boolean> {
    let changed = false;
    try {
      const result = await prisma.cluster.updateMany({
        where: { id: clusterId, status: "failed" },
        data: { status: "ready" },
      });
      changed = result.count > 0;
    } catch (err) {
      console.error(
        `Impossible de remettre le cluster ${clusterId} en service :`,
        err,
      );
      return false;
    }
    if (!changed) return false;
    try {
      await eventBus.emit("cluster.status", {
        clusterId,
        from: "failed",
        to: "ready",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(
        `Impossible d'émettre l'événement de statut pour ${clusterId} :`,
        err,
      );
    }
    return true;
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
