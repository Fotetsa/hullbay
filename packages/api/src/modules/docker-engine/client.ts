import Docker from "dockerode"
import { prisma } from "../../lib/prisma"

/**
 * Connexion à l'API Docker Engine.
 *
 * SÉCURITÉ (cf. plan, risque n°1) : le socket Docker donne un contrôle root
 * effectif sur le VPS. En PROD on ne monte PAS le socket dans l'api : on passe
 * par un docker-socket-proxy (Tecnativa) qui filtre l'API Docker (autorise
 * SERVICES/NETWORKS/VOLUMES/TASKS/NODES/EVENTS/IMAGES, bloque EXEC + écritures
 * conteneur). On configure alors DOCKER_HOST=tcp://socket-proxy:2375.
 *
 * Deux modes :
 *  - DOCKER_HOST=tcp://host:port  → connexion TCP au proxy (PROD recommandé).
 *  - sinon                        → socket Unix local (DEV, ou si proxy absent).
 */

const DOCKER_SOCKET_PATH =
  process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock"

const registry = new Map<string, Docker>()

/** Parse DOCKER_HOST (tcp://host:port) en options dockerode {host, port}. */
function parseDockerHost(value: string): { host: string; port: number } | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "tcp:" && url.protocol !== "http:") return null
    return { host: url.hostname, port: Number(url.port || 2375) }
  } catch {
    return null
  }
}

function buildClient(dockerHost: string | undefined): Docker {
  const tcp = dockerHost ? parseDockerHost(dockerHost) : null
  return tcp ? new Docker(tcp) : new Docker({ socketPath: DOCKER_SOCKET_PATH}) 
}

/**
 * Connexion Docker pour un Cluster donné, 
 */

export async function getDockerForCluster(clusterId: string): Promise<Docker> {
  const cached = registry.get(clusterId)
  if (cached) return cached
  const cluster = await prisma.cluster.findUniqueOrThrow({ where: { id: clusterId } })
  const client = buildClient(cluster.dockerHost)
  registry.set(clusterId, client)
  return client
}

export async function getDefaultCluster(): Promise<{ id: string }> {
  return prisma.cluster.findFirstOrThrow({ where: { isDefault: true } })
}

export interface DockerPingResult {
  ok: boolean;
  version?: string;
  apiVersion?: string;
  containers?: number;
  swarmActive?: boolean;
  error?: string;
}

export async function pingDocker(): Promise<DockerPingResult> {
  try {
    const cluster = await getDefaultCluster();
    const docker = await getDockerForCluster(cluster.id);
    const info = await docker.version();
    const system = (await docker.info()) as {
      Containers?: number;
      Swarm?: { LocalNodeState?: string };
    };
    return {
      ok: true,
      version: info.Version,
      apiVersion: info.ApiVersion,
      containers: system.Containers,
      swarmActive: system.Swarm?.LocalNodeState === "active",
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
