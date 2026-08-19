import { runWorkflow, type Step } from "../lib/workflow"
import { SshSession, shellQuote, type SshCredential } from "../lib/ssh"
import { generateToolKeyPair } from "../lib/keys"
import { DockerEngineService } from "../modules/docker-engine/service"
import { invalidateDockerClient } from "../modules/docker-engine/client"
import { registryService } from "../modules/registry/service"
import { serversService } from "../modules/servers/service"
import { eventBus } from "../lib/event-bus"
import { clusterService } from "../modules/clusters/service"
import { prisma } from "../lib/prisma"
import { decryptSecret } from "../modules/auth/crypto"

/**
 * Provisionne un serveur en ONE-SHOT SSH puis le fait rejoindre le Swarm.
 *
 * SÉCURITÉ :
 *  - La `credential` PERSO (clé/password) vit en MÉMOIRE le temps du workflow,
 *    n'est jamais persistée ni loggée, et la session SSH est fermée à la fin.
 *  - L'app génère SA paire de clés (clé-outil), dépose la publique sur le serveur
 *    (maintenance future), garde la privée chiffrée. C'est ce qui est persisté.
 *  - Toute valeur dynamique injectée dans une commande SSH est shellQuote-ée
 *    (anti-injection — rappel : SshSession.exec passe par un shell distant).
 */

export interface ProvisionInput {
  serverId: string
  host: string
  port: number
  user: string
  role: "manager" | "worker"
  credential: SshCredential
  clusterId: string
  isNewCluster: boolean
}

type ProvShared = {
  session?: SshSession;
  hostKeyFp?: string;
  toolPublicKey?: string;
  toolPrivateKeyEnc?: string;
  swarmNodeId?: string;
  engine?: DockerEngineService;
  hadExistingSwarm?: boolean;
  isNewCluster?: boolean;
};



function log(serverId: string, message: string) {
  // Feedback live vers le front (room server:<id>). Jamais de secret ici.
  void eventBus.emit("provision.step", { serverId, message })
}

/** Résout s.engine à la demande, une seule fois, en le mettant en cache.
 * Ne doit être appelé que quand le cluster cible existe déjà, jamais
 * pour le tout premier manager d'un cluster en cours de création. 
 * */
async function getEngineLazy(input: ProvisionInput, s: ProvShared): Promise<DockerEngineService> {
  if (s.engine) return s.engine
  s.engine = await DockerEngineService.forCluster(input.clusterId)
  return s.engine
}

/**
 * Récupère le join token et l'adresse du manager via SSH direct,
 * en contournant le tunnel Docker API (évite le "socket hang up"
 * causé par les réponses volumineuses de swarmInspect via forwardOut).
 */
async function getJoinTokenViaSsh(
  clusterId: string,
  joinRole: "worker" | "manager",
): Promise<{ token: string; managerAddr: string }> {
  const manager = await prisma.server.findFirst({
    where: { clusterId, role: "manager", status: "ready" },
    orderBy: { createdAt: "asc" },
  })
  if (!manager) {
    throw new Error(`Aucun manager prêt pour le cluster ${clusterId}`)
  }
  if (!manager.privateKeyEnc) {
    throw new Error(`Manager ${manager.name} sans clé de maintenance`)
  }

  const session = await SshSession.connect({
    host: manager.host,
    port: manager.port,
    user: manager.user,
    credential: { type: "key", privateKey: decryptSecret(manager.privateKeyEnc) },
    knownHostKeyFp: manager.hostKeyFp ?? undefined,
  })

  try {
    const tokenRes = await session.exec(`docker swarm join-token -q ${joinRole}`)
    if (tokenRes.code !== 0) {
      throw new Error(`swarm join-token: ${tokenRes.stderr || tokenRes.stdout}`)
    }
    const token = tokenRes.stdout.trim()

    const addrRes = await session.exec("docker info --format '{{.Swarm.NodeAddr}}'")
    if (addrRes.code !== 0 || !addrRes.stdout.trim()) {
      throw new Error(`docker info (NodeAddr): ${addrRes.stderr || addrRes.stdout}`)
    }
    const managerAddr = `${addrRes.stdout.trim()}:2377`

    return { token, managerAddr }
  } finally {
    session.dispose()
  }
}

/**
 * Récupère la liste des nœuds swarm via SSH direct au manager
 * (contourne le tunnel Docker API pour la même raison que getJoinTokenViaSsh).
 */
async function listNodesViaSsh(
  clusterId: string,
): Promise<Array<{ ID?: string; Status?: { Addr?: string }; Description?: { Hostname?: string } }>> {
  const manager = await prisma.server.findFirst({
    where: { clusterId, role: "manager", status: "ready" },
    orderBy: { createdAt: "asc" },
  })
  if (!manager || !manager.privateKeyEnc) return []

  const session = await SshSession.connect({
    host: manager.host,
    port: manager.port,
    user: manager.user,
    credential: { type: "key", privateKey: decryptSecret(manager.privateKeyEnc) },
    knownHostKeyFp: manager.hostKeyFp ?? undefined,
  })

  try {
    const res = await session.exec("docker node ls --format '{{json .}}'")
    if (res.code !== 0) return []
    return res.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return {} }
      })
  } finally {
    session.dispose()
  }
}

const connectStep: Step<ProvisionInput> = {
  name: "connect",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    s.isNewCluster = input.isNewCluster
    log(input.serverId, "connexion SSH...")
    s.session = await SshSession.connect({
      host: input.host,
      port: input.port,
      user: input.user,
      credential: input.credential,
      onHostKey: (fp) => (s.hostKeyFp = fp),
    })
    log(input.serverId, "Connecté.")
  },
  compensate: async (_input, ctx) => {
    ;(ctx.shared as ProvShared).session?.dispose()
  },
}

const installDockerStep: Step<ProvisionInput> = {
  name: "install-docker",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    log(input.serverId, "Vérification / installation de Docker…")
    const check = await s.session!.exec("command -v docker >/dev/null 2>&1 && echo OK || echo NO")
    if (check.stdout.includes("NO")) {
      log(input.serverId, "Installation de Docker (get.docker.com)…")
      const res = await s.session!.exec("curl -fsSL https://get.docker.com | sh")
      if (res.code !== 0) throw new Error(`install docker: ${res.stderr || res.stdout}`)
    }
    log(input.serverId, "Docker présent.")
  },
}

const swarmJoinStep: Step<ProvisionInput> = {
  name: "swarm-join",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared

    const check = await s.session!.exec(
      "docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive",
    );
    // Un Swarm local existe-t-il déjà ? Détermine init (1er manager) vs join.
    const swarmExists = check.stdout.trim() === "active"
    s.hadExistingSwarm = swarmExists

    if (input.role === "manager" && !swarmExists) {
      // 1er manager : initialise le cluster.
      log(input.serverId, "Initialisation du Swarm (manager)…")
      const res = await s.session!.exec(
        `docker swarm init --advertise-addr ${shellQuote(input.host)} || true`
      )
      if (res.code !== 0 && !res.stderr.includes("already part of a swarm")) {
        throw new Error(`swarm init: ${res.stderr}`)
      }

    } else if (input.role === "manager" && swarmExists && s.isNewCluster) { 
      log(input.serverId, "Swarm déjà actif sur ce serveur réutilisé comme nouveau cluster.")
    }else{
      // Worker, OU manager additionnel (HA quorum) : on JOINT le cluster existant
      // avec le token correspondant au rôle demandé.
      // Utilise SSH direct au lieu du tunnel Docker API pour éviter le
      // "socket hang up" causé par les réponses volumineuses de swarmInspect.
      const joinRole = input.role === "manager" ? "manager" : "worker"
      log(input.serverId, `Récupération du token de cluster (${joinRole})…`)
      const { token, managerAddr } = await getJoinTokenViaSsh(input.clusterId, joinRole)
      log(input.serverId, `Jonction au Swarm (${joinRole})…`)
      const res = await s.session!.exec(
        `docker swarm join --token ${shellQuote(token)} ${shellQuote(managerAddr)}`
      )
      if (res.code !== 0 && !res.stderr.includes("already part of a swarm")) {
        throw new Error(`swarm join: ${res.stderr}`)
      }
    }
    log(input.serverId, "Nœud dans le cluster.")
  },
  compensate: async (input, ctx) => {
    // Rollback : faire quitter le nœud pour ne pas laisser de nœud fantôme.
    const s = ctx.shared as ProvShared
    await s.session?.exec("docker swarm leave --force").catch(() => {})
  },
}

export const deploySocketProxyStep: Step<ProvisionInput> = {
  name: "deploy-socket-proxy",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared;
    // Seulement pour le 1er manager d'un NOUVEAU cluster — un worker ou un
    // manager additionnel (HA) rejoint un cluster qui a déjà son proxy.
    const isFirstManagerOfNewCluster =
      input.role === "manager" && s.isNewCluster;
    if (!isFirstManagerOfNewCluster) return;

    log(input.serverId, "Déploiement du docker-socket-proxy…");

    const check = await s.session!.exec(
      "docker ps -a --filter name=hullbay-socket-proxy --format '{{.Names}}'",
    );
    if (check.stdout.includes("hullbay-socket-proxy")) {
      log(input.serverId, "socket-proxy déjà présent.");
      return;
    }

    // Mêmes restrictions exactes que le socket-proxy système (docker-compose.prod.yml)
    const cmd = [
      "docker run -d",
      "--name hullbay-socket-proxy",
      "--restart unless-stopped",
      "-e EVENTS=1 -e PING=1 -e VERSION=1 -e INFO=1 -e SERVICES=1 -e TASKS=1",
      "-e NODES=1 -e NETWORKS=1 -e SWARM=1 -e IMAGES=1 -e VOLUMES=1 -e SECRETS=1 -e POST=1",
      "-e EXEC=0 -e CONTAINERS=0 -e ALLOW_RESTARTS=0",
      "-v /var/run/docker.sock:/var/run/docker.sock:ro",
      `-p 127.0.0.1:2375:2375`,
      "tecnativa/docker-socket-proxy:latest",
    ].join(" ");

    const res = await s.session!.exec(cmd);
    if (res.code !== 0)
      throw new Error(`socket-proxy: ${res.stderr || res.stdout}`);

    //log(input.serverId, "socket-proxy démarré.");
    log(
      input.serverId,
      `docker-socket-proxy démarré : port 2375 bindé sur 127.0.0.1 uniquement. ` +
        `Pas d'exposition publique, accès via tunnel SSH — aucune règle pare-feu requise.`,
    );
  },
  compensate: async (_input, ctx) => {
    const s = ctx.shared as ProvShared;
    await s.session?.exec("docker rm -f hullbay-socket-proxy").catch(() => {});
  },
};

export const deployCaddyStep: Step<ProvisionInput> = {
  name: "deploy-caddy",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared;
    const isFirstManagerOfNewCluster =
      input.role === "manager" && s.isNewCluster;
    if (!isFirstManagerOfNewCluster) return;

    log(input.serverId, "Déploiement de Caddy (cluster)…");

    const check = await s.session!.exec(
      "docker ps -a --filter name=hullbay-caddy --format '{{.Names}}'",
    );
    if (check.stdout.includes("hullbay-caddy")) {
      log(input.serverId, "Caddy déjà présent.");
      return;
    }

    // Config minimale : un serveur HTTP `:80` est nécessaire dès le départ —
    // resolveServerName (gateways/exposure) exige un serveur existant pour
    // insérer des routes. Tout le reste est ajouté dynamiquement via l'API
    // admin (exposure/settings), comme pour le système.
    await s.session!.exec(
      `mkdir -p /opt/hullbay-caddy && printf '{\\n\\tadmin 0.0.0.0:2019\\n}\\n\\n:80\\n' > /opt/hullbay-caddy/Caddyfile`,
    );

    const cmd = [
      "docker run -d",
      "--name hullbay-caddy",
      "--restart unless-stopped",
      "-p 80:80 -p 443:443",
      // Admin bindé sur l'IP du serveur, pas 0.0.0.0 — même logique que le
      // socket-proxy (à compléter par pare-feu, IP hullbay uniquement).
      `-p 127.0.0.1:2019:2019`,
      "-v /opt/hullbay-caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
      "-v hullbay_caddy_data:/data",
      // Persiste l'autosave de Caddy (config admin) pour survivre aux restarts.
      "-v hullbay_caddy_config:/config/caddy",
      "caddy:2-alpine",
      // --resume : charge l'autosave s'il existe (config persistée par hullbay),
      // sinon fallback sur le Caddyfile (premier démarrage).
      "caddy", "run",
      "--config", "/etc/caddy/Caddyfile",
      "--adapter", "caddyfile",
      "--resume",
    ].join(" ");

    const res = await s.session!.exec(cmd);
    if (res.code !== 0) throw new Error(`caddy: ${res.stderr || res.stdout}`);

    log(input.serverId, "Caddy démarré.");
    log(
      input.serverId,
      `Admin Caddy publié sur 127.0.0.1 de l'hôte uniquement (réseau bridge interne isolé). ` +
        `Pas d'exposition publique, accès via tunnel SSH — aucune règle pare-feu requise.`,
    );
  },
  compensate: async (_input, ctx) => {
    const s = ctx.shared as ProvShared;
    await s.session?.exec("docker rm -f hullbay-caddy").catch(() => {});
  },
};

export const finalizeClusterStep: Step<ProvisionInput> = {
  name: "finalize-cluster",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared;
    if (s.isNewCluster) {
      await clusterService.markReady(
        input.clusterId,
        `tcp://${input.host}:2375`,
        `http://${input.host}:2019`,
      );
    }
  },
};

const registryLoginStep: Step<ProvisionInput> = {
  name: "registry-login",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    // Login pour TOUS les registres configurés (Docker Hub, GHCR, custom…).
    const registries = await registryService.listForLogin()
    if (registries.length === 0) {
      log(input.serverId, "Pas de credentials registre — étape ignorée.")
      return
    }
    for (const creds of registries) {
      // docker.io → host de login canonique.
      const target = creds.registry === "docker.io" ? "docker.io" : creds.registry
      log(input.serverId, `Connexion au registre (${creds.registry})…`)
      // token via stdin (--password-stdin) : jamais en argument visible.
      const res = await s.session!.exec(
        `echo ${shellQuote(creds.token)} | docker login ${shellQuote(target)} -u ${shellQuote(creds.username)} --password-stdin`
      )
      if (res.code !== 0) throw new Error(`docker login ${creds.registry}: ${res.stderr}`)
    }
    log(input.serverId, "Registres connectés.")
  },
}

const installToolKeyStep: Step<ProvisionInput> = {
  name: "install-tool-key",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    log(input.serverId, "Installation de la clé de maintenance…")
    const pair = generateToolKeyPair()
    await s.session!.appendAuthorizedKey(pair.publicKey)
    s.toolPublicKey = pair.publicKey
    s.toolPrivateKeyEnc = pair.privateKeyEnc
  },
}

const persistStep: Step<ProvisionInput> = {
  name: "persist",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared;
    let swarmNodeId: string | undefined;
    try {
      if (input.role === "manager" && s.isNewCluster) {
        const res = await s.session!.exec(
          "docker node inspect self --format '{{.ID}}'",
        );
        if (res.code === 0 && res.stdout.trim())
          swarmNodeId = res.stdout.trim();
      } else {
        // Worker, ou manager additionnel (HA) : le cluster existe déjà,
        // le manager cible (potentiellement un AUTRE serveur) est ready.
        // Utilise SSH direct au lieu du tunnel Docker API (même raison que swarm-join).
        const nodes = await listNodesViaSsh(input.clusterId)
        const match = nodes.find(
          (n) =>
            (n as { Status?: { Addr?: string } }).Status?.Addr === input.host ||
            (n as { Description?: { Hostname?: string } }).Description
              ?.Hostname === input.host,
        );
        swarmNodeId = (match as { ID?: string } | undefined)?.ID;
      }
    } catch {
      // best effort
    }
    await serversService.update(input.serverId, {
      status: "ready",
      role: input.role,
      swarmNodeId: swarmNodeId ?? null,
      privateKeyEnc: s.toolPrivateKeyEnc ?? null,
      publicKey: s.toolPublicKey ?? null,
      hostKeyFp: s.hostKeyFp ?? null,
      lastError: null,
    });
    log(input.serverId, "Serveur enregistré et prêt.");
  },
};

export async function provisionServerWorkflow(input: ProvisionInput): Promise<void> {
  const shared: ProvShared = {}
  try {
    const result = await runWorkflow<ProvisionInput>(
      "provision-server",
      [
        connectStep,
        installDockerStep,
        swarmJoinStep,
        deploySocketProxyStep,
        deployCaddyStep,
        finalizeClusterStep,
        registryLoginStep,
        installToolKeyStep,
        persistStep,
      ],
      input,
      {},
      shared as unknown as Record<string, unknown>,
    );
    if (!result.ok) {
      await serversService.update(input.serverId, {
        status: "error",
        lastError: result.error ?? "échec provisioning",
      });
      if (input.isNewCluster) {
        await clusterService.markFailed(input.clusterId); // remplace le bloc prisma+eventBus+console.log
      }
      await eventBus.emit("provision.step", {
        serverId: input.serverId,
        message: `Échec : ${result.error}`,
      });
      throw new Error(result.error || "provisioning échoué");
    }
    await eventBus.emit("server.provisioned", {
      serverId: input.serverId,
      role: input.role,
    })
  } finally {
    // Ferme la session ET garantit qu'aucune trace de la credential perso ne
    // subsiste (elle n'a jamais quitté `input.credential` en mémoire locale).
    ;(shared as ProvShared).session?.dispose()
  }
}