import Docker from "dockerode"
import { prisma } from "../../lib/prisma"
import { ensureTunnel } from "../../lib/ssh-tunnel"

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

/** Paramètres de connexion TCP à l'API Docker. */
interface DockerHostParams {
  host: string;
  port: number;
  protocol?: "http" | "https";
}

/**
 * Parse DOCKER_HOST (tcp://, http:// ou https://) en options dockerode.
 * Le protocol est explicité ((tcp|http) → http, https → https) : docker-modem
 * retombe déjà sur http par défaut, mais l'expliciter évite toute ambiguïté et
 * — surtout — `https:` était silencieusement rejeté → fallback socket Unix local
 * (mauvais daemon). https passe en TLS par les CA système ; le TLS mutuel
 * (ca/cert/key) n'est pas supporté (le modèle Cluster n'a pas ces champs).
 */
function parseDockerHost(value: string): DockerHostParams | null {
  try {
    const url = new URL(value)
    let protocol: "http" | "https"
    if (url.protocol === "http:") protocol = "http"
    else if (url.protocol === "https:") protocol = "https"
    else if (url.protocol === "tcp:") protocol = "http"
    else return null
    return { host: url.hostname, port: Number(url.port || (protocol === "https" ? 2376 : 2375)), protocol }
  } catch {
    return null
  }
}

async function resolveConnectionParams(cluster: {
  id: string;
  isDefault: boolean;
  dockerHost: string;
}): Promise<DockerHostParams | null> {
  const parsed = parseDockerHost(cluster.dockerHost);
  if (cluster.isDefault) return parsed;
  const remotePort = parsed?.port ?? 2375;
  const localPort = await ensureTunnel(cluster.id, remotePort);
  // Tunnel SSH → forward TCP brut : le protocol d'origine est conservé (http
  // pour le proxy socket Tecnativa, https si le daemon parle TLS, TLS se
  // terminant au daemon distant et traversant le tunnel sans modification).
  return { host: "127.0.0.1", port: localPort, protocol: parsed?.protocol ?? "http" };
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
  const params = await resolveConnectionParams(cluster)

  let client: Docker
  let connectionMode: string

  if (params) {
    client = new Docker(params);

    if (cluster.isDefault) {
      connectionMode = `tcp://${params.host}:${params.port}`;
      console.log(
        `[docker-engine] Cluster ${clusterId} (${cluster.name}): connexion TCP directe ${connectionMode}`,
      );
    } else {
      connectionMode = `tunnel 127.0.0.1:${params.port} → ${cluster.dockerHost}`;
      console.log(
        `[docker-engine] Cluster ${clusterId} (${cluster.name}): connexion via SSH tunnel ${connectionMode}`,
      );
    }
  } else {
    client = new Docker({ socketPath: DOCKER_SOCKET_PATH });
    connectionMode = `socket ${DOCKER_SOCKET_PATH}`;
    console.log(
      `[docker-engine] Cluster ${clusterId} (${cluster.name}): connexion via socket Unix ${connectionMode}`,
    );
  }
  registry.set(clusterId, client)
  return client
}

export async function getDefaultCluster() {
  const existing = await prisma.cluster.findFirst({ where: { isDefault: true } })
  if (existing) return existing
  return prisma.cluster.create({
    data: {
      name: "Default",
      dockerHost: process.env.DOCKER_HOST || "tcp://socket-proxy:2375",
      caddyAdminUrl: process.env.CADDY_ADMIN_URL || "http://caddy:2019",
      isDefault: true,
    },
  })
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
