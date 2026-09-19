import { SshSession, shellQuote } from "../lib/ssh";
import { decryptSecret } from "../modules/auth/crypto";
import { prisma } from "../lib/prisma";
import { clusterService } from "../modules/clusters/service";
import { invalidateDockerClient } from "../modules/docker-engine/client";
import { eventBus } from "../lib/event-bus";

/**
 * Le proxy Docker et Caddy d'un cluster distant ne sont déployés que sur un
 * seul serveur, celui qui était le tout premier manager au moment de la
 * création du cluster. Le tunnel SSH, lui, choisit toujours le manager le
 * plus ancien encore marqué prêt pour s'y connecter, sans jamais regarder
 * quelle machine héberge réellement ces deux services. Tant que ce premier
 * manager reste en place, les deux notions coïncident et tout fonctionne.
 * Le jour où on le retire, elles divergent, le tunnel se connecte avec
 * succès à un nouveau manager qui n'a jamais rien eu d'installé dessus, et
 * le cluster devient injoignable sans qu'aucune erreur claire ne l'explique.
 */

async function isCurrentAnchor(
  clusterId: string,
  serverId: string,
): Promise<boolean> {
  const anchor = await prisma.server.findFirst({
    where: { clusterId, role: "manager", status: "ready" },
    orderBy: { createdAt: "asc" },
  });
  return anchor?.id === serverId;
}

/**
 * Ouvre une session vers un serveur en réutilisant sa clé de maintenance
 * déjà déposée lors de son provisionnement, exactement comme le fait le
 * reste du provisionnement quand il a besoin de reparler à un manager déjà
 * en place.
 */
async function connectWithToolKey(server: {
  host: string;
  port: number;
  user: string;
  privateKeyEnc: string | null;
  hostKeyFp: string | null;
}): Promise<SshSession> {
  if (!server.privateKeyEnc) {
    throw new Error(
      "ce serveur n'a pas de clé de maintenance enregistrée, la migration est impossible",
    );
  }
  return SshSession.connect({
    host: server.host,
    port: server.port,
    user: server.user,
    credential: {
      type: "key",
      privateKey: decryptSecret(server.privateKeyEnc),
    },
    knownHostKeyFp: server.hostKeyFp ?? undefined,
    connectTimeoutMs: 15_000,
  });
}

/**
 * Déploie le proxy Docker et Caddy sur le serveur donné, avec exactement les
 * mêmes commandes et les mêmes restrictions réseau que le tout premier
 * provisionnement d'un cluster. Idempotente, comme les étapes d'origine :
 * si un conteneur du même nom tourne déjà, elle ne fait rien.
 */
async function deployAnchorServices(session: SshSession): Promise<void> {
  const proxyCheck = await session.exec(
    "docker ps -a --filter name=hullbay-socket-proxy --format '{{.Names}}'",
  );
  if (!proxyCheck.stdout.includes("hullbay-socket-proxy")) {
    const proxyCmd = [
      "docker run -d",
      "--name hullbay-socket-proxy",
      "--restart unless-stopped",
      "-e EVENTS=1 -e PING=1 -e VERSION=1 -e INFO=1 -e SERVICES=1 -e TASKS=1",
      "-e NODES=1 -e NETWORKS=1 -e SWARM=1 -e IMAGES=1 -e VOLUMES=1 -e SECRETS=1 -e POST=1",
      "-e EXEC=0 -e CONTAINERS=0 -e ALLOW_RESTARTS=0",
      "-v /var/run/docker.sock:/var/run/docker.sock:ro",
      "-p 127.0.0.1:2375:2375",
      "tecnativa/docker-socket-proxy:latest",
    ].join(" ");
    const res = await session.exec(proxyCmd);
    if (res.code !== 0) throw new Error(`proxy : ${res.stderr || res.stdout}`);
  }

  const caddyCheck = await session.exec(
    "docker ps -a --filter name=hullbay-caddy --format '{{.Names}}'",
  );
  if (!caddyCheck.stdout.includes("hullbay-caddy")) {
    await session.exec(
      `mkdir -p /opt/hullbay-caddy && printf '{\\n\\tadmin 0.0.0.0:2019\\n}\\n\\n:80\\n' > /opt/hullbay-caddy/Caddyfile`,
    );
    const caddyCmd = [
      "docker run -d",
      "--name hullbay-caddy",
      "--restart unless-stopped",
      "-p 80:80 -p 443:443",
      "-p 127.0.0.1:2019:2019",
      "-v /opt/hullbay-caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
      "-v hullbay_caddy_data:/data",
      "-v hullbay_caddy_config:/config/caddy",
      "caddy:2-alpine",
      "caddy",
      "run",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
      "--resume",
    ].join(" ");
    const res = await session.exec(caddyCmd);
    if (res.code !== 0) throw new Error(`caddy : ${res.stderr || res.stdout}`);
  }
}

/**
 * Point d'entrée appelé avant de retirer un serveur du cluster. Ne fait
 * strictement rien si ce serveur n'est pas celui que le tunnel choisirait
 * actuellement, puisque dans ce cas il n'héberge rien de critique. Retourne
 * vrai si la migration a réussi ou n'était pas nécessaire, faux si elle
 * était nécessaire mais n'a pas pu aboutir, auquel cas l'appelant doit
 * refuser le retrait plutôt que de laisser le cluster dans un état cassé.
 */
export async function migrateClusterAnchorIfNeeded(
  clusterId: string,
  leavingServerId: string,
): Promise<boolean> {
  const isAnchor = await isCurrentAnchor(clusterId, leavingServerId);
  if (!isAnchor) return true;

  const candidate = await prisma.server.findFirst({
    where: {
      clusterId,
      role: "manager",
      status: "ready",
      id: { not: leavingServerId },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return false;

  let session: SshSession;
  try {
    session = await connectWithToolKey(candidate);
  } catch (err) {
    console.error(
      `[cluster-anchor] impossible de se connecter au futur relais ${candidate.id} pour le cluster ${clusterId} : ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  try {
    await deployAnchorServices(session);
  } catch (err) {
    console.error(
      `[cluster-anchor] échec du déploiement des services d'administration sur ${candidate.id} pour le cluster ${clusterId} : ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    session.dispose();
  }

  const dockerHost = `tcp://${candidate.host}:2375`;
  const caddyAdminUrl = `http://${candidate.host}:2019`;
  await prisma.cluster.update({
    where: { id: clusterId },
    data: { dockerHost, caddyAdminUrl },
  });
  invalidateDockerClient(clusterId);
  await eventBus
    .emit("cluster.anchor.migrated", {
      clusterId,
      newAnchorServerId: candidate.id,
      dockerHost,
      caddyAdminUrl,
    })
    .catch(() => {});

  console.info(
    `[cluster-anchor] le cluster ${clusterId} bascule ses services d'administration sur le serveur ${candidate.id}.`,
  );
  return true;
}
