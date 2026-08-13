import { runWorkflow, type Step } from "../lib/workflow"
import { SshSession, shellQuote, type SshCredential } from "../lib/ssh"
import { generateToolKeyPair } from "../lib/keys"
import { DockerEngineService } from "../modules/docker-engine/service"
import { registryService } from "../modules/registry/service"
import { serversService } from "../modules/servers/service"
import { eventBus } from "../lib/event-bus"
import { prisma } from "../lib/prisma"

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
  credential: SshCredential // PERSO — mémoire seule
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

const connectStep: Step<ProvisionInput> = {
  name: "connect",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    s.isNewCluster = input.isNewCluster
    s.engine = await DockerEngineService.forCluster(input.clusterId)
    log(input.serverId, "Connexion SSH…")
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
    // Un Swarm local existe-t-il déjà ? Détermine init (1er manager) vs join.
    const swarmExists = await s.engine!.isSwarmActive().catch(() => false)
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

      
    } else {
      // Worker, OU manager additionnel (HA quorum) : on JOINT le cluster existant
      // avec le token correspondant au rôle demandé.
      const joinRole = input.role === "manager" ? "manager" : "worker"
      log(input.serverId, `Récupération du token de cluster (${joinRole})…`)
      const { token, managerAddr } = await s.engine!.getSwarmJoinInfo(joinRole)
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

export const finalizeClusterStep: Step<ProvisionInput> = {
  name: "finalize-cluster",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    if (s.isNewCluster) {
      await prisma.cluster.update({
        where: { id: input.clusterId },
        data: { dockerHost: `tcp://${input.host}:2375`, caddyAdminUrl: `http://${input.host}:2019`, status: "ready"},
      })
    }
  },
}

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
    const s = ctx.shared as ProvShared
    // Récupère l'ID du nœud Swarm correspondant (par hostname/adresse).
    let swarmNodeId: string | undefined
    try {
      const nodes = await s.engine!.listNodes();
      const match = nodes.find(
        (n) =>
          (n as { Status?: { Addr?: string } }).Status?.Addr === input.host ||
          (n as { Description?: { Hostname?: string } }).Description?.Hostname === input.host
      )
      swarmNodeId = (match as { ID?: string } | undefined)?.ID
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
    })
    log(input.serverId, "Serveur enregistré et prêt.")
  },
}

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
      })
      if (input.isNewCluster) {
        await prisma.cluster
          .update({
            where: { id: input.clusterId },
            data: { status: "failed" },
          })
          .catch(() => {});
      }
      await eventBus.emit("provision.step", {
        serverId: input.serverId,
        message: `Échec : ${result.error}`,
      })
      throw new Error(result.error || "provisioning échoué")
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

const deploySocketProxyStep: Step<ProvisionInput> = {
  name: "deploy-socket-proxy",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared;
    // Seulement pour le 1er manager d'un NOUVEAU cluster — un worker ou un
    // manager additionnel (HA) rejoint un cluster qui a déjà son proxy.
    const swarmWasFreshlyInitialized =
      input.role === "manager" && !s.hadExistingSwarm;
    if (!swarmWasFreshlyInitialized) return;

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
      `SÉCURITÉ CRITIQUE : le port 2375 (Docker API) est exposé sur ${input.host}. ` +
        `Restreins-le maintenant à l'IP de ce serveur hullbay. Sur un VPS classique : ` +
        `ssh ${input.user}@${input.host} "ufw allow from <IP_HULLBAY> to any port 2375 proto tcp && ufw allow 22 && ufw --force enable". ` +
        `Tant que ce n'est pas fait, n'importe qui avec cette IP a un contrôle total du serveur.`,
    );
  },
  compensate: async (_input, ctx) => {
    const s = ctx.shared as ProvShared;
    await s.session?.exec("docker rm -f hullbay-socket-proxy").catch(() => {});
  },
};


const deployCaddyStep: Step<ProvisionInput> = {
  name: "deploy-caddy",
  run: async (input, ctx) => {
    const s = ctx.shared as ProvShared
    const swarmWasFreshlyInitialized = input.role === "manager" && !s.hadExistingSwarm
    if (!swarmWasFreshlyInitialized) return

    log(input.serverId, "Déploiement de Caddy (cluster)…")

    const check = await s.session!.exec("docker ps -a --filter name=hullbay-caddy --format '{{.Names}}'")
    if (check.stdout.includes("hullbay-caddy")) {
      log(input.serverId, "Caddy déjà présent.")
      return
    }

    // Config minimale : admin seul, aucun site pré-défini — tout sera ajouté
    // dynamiquement via l'API admin (exposure/settings), comme pour le système.
    await s.session!.exec(
      `mkdir -p /opt/hullbay-caddy && printf '{\\n\\tadmin 0.0.0.0:2019\\n}\\n' > /opt/hullbay-caddy/Caddyfile`
    )

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
      "caddy:2-alpine",
    ].join(" ")

    const res = await s.session!.exec(cmd)
    if (res.code !== 0) throw new Error(`caddy: ${res.stderr || res.stdout}`)

    log(input.serverId, "Caddy démarré.")
    log(
      input.serverId,
      `SÉCURITÉ CRITIQUE : le port 2019 (Docker API) est exposé sur ${input.host}. ` +
        `Restreins-le maintenant à l'IP de ce serveur hullbay. Sur un VPS classique : ` +
        `ssh ${input.user}@${input.host} "ufw allow from <IP_HULLBAY> to any port 2375 proto tcp && ufw allow 22 && ufw --force enable". ` +
        `Tant que ce n'est pas fait, n'importe qui avec cette IP a un contrôle total du serveur.`,
    );
  },
  compensate: async (_input, ctx) => {
    const s = ctx.shared as ProvShared
    await s.session?.exec("docker rm -f hullbay-caddy").catch(() => {})
  },
}