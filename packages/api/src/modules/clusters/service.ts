import { prisma } from "../../lib/prisma";
import { eventBus } from "../../lib/event-bus";

export type ClusterStatus = "pending" | "ready" | "failed"

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
  createPending(name: string) {
    return prisma.cluster.create({
      data: { name, dockerHost: "", caddyAdminUrl: "", status: "pending" },
    });
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
        form: "peding",
        to: "failed",
        timesTamp: new Date().toISOString(),
      })
      .catch(() => {});
  }

  /**
   * Supprimer un cluster non opérationnel, et impossible de supprimer un Cluster
   * avec pour status "ready"
   */
  async remove(id: string): Promise<{ removedServers: number }> {
    const cluster = await this.get(id);
    if (!cluster) {
      const err = new Error("cluster introuvable");
      (err as Error & { statusCode?: number }).statusCode = 404;
      throw err;
    }
    if (cluster.status === "ready") {
      const err = new Error(
        "impossible de supprimer un cluster opérationnel — retire d'abord ses serveurs",
      );
      (err as Error & { statusCode?: number }).statusCode = 409;
      throw err;
    }
    const removedServers = await prisma.server.count({
      where: { clusterId: id },
    });
    await prisma.cluster.delete({ where: { id } });
    return { removedServers };
  }
}

export const clusterService = new ClusterService()