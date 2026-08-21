import type Docker from "dockerode"
import type {
  ContainerConfig,
  NetworkConfig,
  VolumeConfig,
  PullPolicy,
} from "@hullbay/shared"
import { managedFilter, projectFilter, LabelKeys } from "@hullbay/shared"
import { getDockerForCluster } from "./client"

/**
 * Erreur "image indisponible" : levée quand l'image ne peut être obtenue selon la
 * pull policy (pull registre échoué, ou image absente localement en Never). Permet
 * au workflow de la traduire en erreur métier (422) au lieu d'un 500 brut.
 */
export class ImageUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImageUnavailableError"
  }
}

/**
 * Wrapper dockerode — mode DOCKER SWARM (services). Chaque "conteneur" du canvas
 * est un SERVICE répliqué : load balancing natif (routing mesh), rolling update
 * zero-downtime, self-healing. Pose toujours nos labels bozando.* (sur le service
 * ET le ContainerSpec des tasks).
 */

export type ServiceMount = { volumeName: string; target: string; readOnly?: boolean }

/** Secret Swarm résolu (id + nom) prêt à être référencé dans une spec de service. */
export type ResolvedSecret = { id: string; name: string; target?: string }

export type RegistryAuth = { username: string; password: string; serveraddress: string }
/** Résout l'auth registre pour une image (injecté pour éviter le couplage engine→registry). */
export type AuthResolver = (image: string) => Promise<RegistryAuth | null>

/** Échappe les caractères spéciaux regex d'une chaîne (ex. registre `host:port`). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Métriques agrégées d'un service géré (HealthPage + auto-scaler). */
export type ServiceMetrics = {
  serviceId: string
  name: string
  desiredReplicas: number
  runningReplicas: number
  sampledTasks: number
  avgCpuPct: number
  totalMemBytes: number
}

/**
 * Placement d'une task (replica) d'un service : sur quel nœud Swarm elle tourne et
 * son état. Permet de répondre à "sur quel serveur ce projet/service tourne-t-il ?".
 */
export type TaskPlacement = {
  taskId: string
  nodeId: string
  state: string // running | preparing | starting | failed | shutdown | rejected …
  desiredState: string
  error?: string
}

/** Sous-ensemble du payload d'une task Swarm qu'on exploite (dockerode type lâche). */
type RawTask = {
  ID?: string
  NodeID?: string
  DesiredState?: string
  Status?: { State?: string; Err?: string }
}

/** Sous-ensemble du payload `container.stats` qu'on exploite (dockerode le type en `any`). */
type DockerStats = {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] }
    system_cpu_usage: number
    online_cpus?: number
  }
  precpu_stats: {
    cpu_usage: { total_usage: number }
    system_cpu_usage: number
  }
  memory_stats: { usage?: number; limit?: number }
}

export class DockerEngineService {
  private docker: Docker
  private authResolver?: AuthResolver
  constructor(docker: Docker, authResolver?: AuthResolver) {
    this.docker = docker
    this.authResolver = authResolver
  }

  static async forCluster(clusterId: string, authResolver?: AuthResolver): Promise<DockerEngineService> {
    const docker = await getDockerForCluster(clusterId)
    return new DockerEngineService(docker, authResolver)
  }

  // ── État Swarm ────────────────────────────────────────────────────────────

  /** Vérifie que le démon est en mode Swarm (prérequis aux services). */
  async isSwarmActive(): Promise<boolean> {
    try {
      const info = (await this.docker.info()) as { Swarm?: { LocalNodeState?: string } }
      return info.Swarm?.LocalNodeState === "active"
    } catch {
      return false
    }
  }

  /** Liste les nœuds du cluster Swarm (managers + workers). */
  async listNodes() {
    return this.docker.listNodes()
  }

  /**
   * Récupère le join-token (worker ou manager) du Swarm + l'adresse du manager.
   * Nécessaire pour faire rejoindre un nouveau serveur au cluster.
   */
  async getSwarmJoinInfo(role: "worker" | "manager" = "worker"): Promise<{
    token: string
    managerAddr: string
  }> {
    const sw = (await this.docker.swarmInspect()) as {
      JoinTokens?: { Worker?: string; Manager?: string }
    }
    const info = (await this.docker.info()) as {
      Swarm?: { NodeAddr?: string; RemoteManagers?: { Addr?: string }[] }
    }
    const token = role === "manager" ? sw.JoinTokens?.Manager : sw.JoinTokens?.Worker
    const addr =
      info.Swarm?.RemoteManagers?.[0]?.Addr ||
      (info.Swarm?.NodeAddr ? `${info.Swarm.NodeAddr}:2377` : "")
    if (!token || !addr) throw new Error("Swarm join info indisponible (manager actif requis)")
    return { token, managerAddr: addr }
  }

  /** Retire un nœud du cluster (après drain). Tolérant si déjà absent. */
  async removeNode(swarmNodeId: string) {
    try {
      await this.docker.getNode(swarmNodeId).remove({ force: true })
    } catch {
      // déjà retiré
    }
  }

  /**
   * Change le rôle d'un nœud Swarm (manager <-> worker) — HA quorum Raft.
   * Promouvoir des managers donne la résilience du control plane (un cluster sain
   * exige un nombre IMPAIR de managers : 3 tolère 1 panne, 5 en tolère 2).
   */
  async setNodeRole(swarmNodeId: string, role: "manager" | "worker") {
    const node = this.docker.getNode(swarmNodeId)
    const info = (await node.inspect()) as { Version?: { Index?: number }; Spec?: object }
    await node.update({
      version: info.Version?.Index,
      ...(info.Spec as object),
      Role: role,
    })
  }

  /** Nombre de managers Reachable (pour évaluer la santé du quorum Raft). */
  async managerHealth(): Promise<{ total: number; reachable: number; quorumOk: boolean }> {
    const nodes = (await this.docker.listNodes()) as {
      Spec?: { Role?: string }
      ManagerStatus?: { Reachability?: string }
    }[]
    const managers = nodes.filter((n) => n.Spec?.Role === "manager")
    const reachable = managers.filter(
      (n) => n.ManagerStatus?.Reachability === "reachable"
    ).length
    // Quorum = majorité stricte des managers joignables.
    const quorumOk = managers.length > 0 && reachable > Math.floor(managers.length / 2)
    return { total: managers.length, reachable, quorumOk }
  }

  /** Passe un nœud en drain (les tasks sont reschedulées ailleurs avant retrait). */
  async drainNode(swarmNodeId: string) {
    const node = this.docker.getNode(swarmNodeId)
    const info = (await node.inspect()) as { Version?: { Index?: number }; Spec?: object }
    await node.update({
      version: info.Version?.Index,
      ...(info.Spec as object),
      Availability: "drain",
    })
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  /** Tous nos services gérés. */
  async listManagedServices() {
    return this.docker.listServices({ filters: managedFilter() })
  }

  /** Services gérés d'un projet donné. */
  async listProjectServices(projectId: string) {
    return this.docker.listServices({ filters: projectFilter(projectId) })
  }

  async listManagedNetworks() {
    return this.docker.listNetworks({ filters: managedFilter() })
  }

  async listManagedVolumes() {
    const res = await this.docker.listVolumes({ filters: managedFilter() })
    return res.Volumes ?? []
  }

  async inspectService(id: string) {
    return this.docker.getService(id).inspect()
  }

  /** Tasks (replicas) d'un service — pour l'état fin (running/failed). */
  async listServiceTasks(serviceId: string) {
    return this.docker.listTasks({ filters: { service: [serviceId] } })
  }

  /**
   * Tous les conteneurs gérés (tous services confondus, tous nœuds), en un seul
   * appel. Vérifié en live sur ce cluster (Docker 29.1.3) : les events Swarm de
   * type "task" n'existent PAS pour ce démon (seuls "service"/"container"/"image"/
   * "network" apparaissent réellement) — les labels bozando.* sont en revanche
   * bien présents sur les events ET le payload `container.list()` via
   * `ContainerSpec.Labels` propagés au conteneur réel. Sert au snapshot d'état
   * initial de l'observer (sans ça, un conteneur déjà démarré avant un redémarrage
   * de l'API reste figé en base jusqu'au prochain event Docker).
   */
  async listManagedContainers() {
    return this.docker.listContainers({ all: true, filters: managedFilter() })
  }

  /**
   * Placement des tasks d'un service : nœud Swarm + état de chaque replica.
   * Source de "sur quel serveur tourne ce service". Lecture seule.
   */
  async listServiceTaskPlacements(serviceId: string): Promise<TaskPlacement[]> {
    const tasks = (await this.listServiceTasks(serviceId)) as RawTask[]
    return tasks.map((t) => ({
      taskId: t.ID ?? "",
      nodeId: t.NodeID ?? "",
      state: t.Status?.State ?? "unknown",
      desiredState: t.DesiredState ?? "unknown",
      error: t.Status?.Err || undefined,
    }))
  }

  // ── Observabilité (stats CPU/mém + santé services) ──────────────────────────

  /**
   * Échantillon de stats d'un conteneur (CPU %, mémoire) en one-shot (stream:false).
   * Le calcul du % CPU suit la formule de la CLI Docker (delta conteneur / delta système).
   * Tolérant : retourne null si le conteneur a disparu entre-temps (task reschedulée).
   */
  async sampleContainerStats(
    containerId: string
  ): Promise<{ cpuPct: number; memBytes: number; memLimit: number } | null> {
    try {
      const s = (await this.docker
        .getContainer(containerId)
        .stats({ stream: false })) as DockerStats
      const cpuDelta =
        s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
      const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage
      const cores =
        s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1
      const cpuPct =
        sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0
      return {
        cpuPct: Math.round(cpuPct * 100) / 100,
        memBytes: s.memory_stats.usage ?? 0,
        memLimit: s.memory_stats.limit ?? 0,
      }
    } catch {
      return null
    }
  }

  /**
   * Métriques agrégées par service géré : replicas désirés/en cours, et stats
   * moyennes CPU/mém des tasks running. Base de la HealthPage ET de l'auto-scaler.
   * NB : les stats par task ne sont disponibles que pour les tasks LOCALES à ce
   * nœud (le conteneur tourne ici) ; sur multi-nœuds, le manager ne voit pas les
   * conteneurs distants via le sock local → les tasks distantes comptent en
   * replicas mais pas dans la moyenne CPU. C'est une limite connue (Swarm n'expose
   * pas de métriques cross-nœud nativement).
   */
  /**
   * Résout le service Swarm d'un nœud canvas par son label `bozando.nodeId` (1
   * nœud container = 1 service). Filtre côté serveur Docker (rapide, pas de
   * listing complet). `null` si le service n'existe pas (pas encore déployé /
   * détruit) — appelant tolérant requis.
   */
  async findServiceIdByNodeId(nodeId: string): Promise<string | null> {
    const services = (await this.docker.listServices({
      filters: { label: [`${LabelKeys.nodeId}=${nodeId}`] },
    })) as { ID?: string }[]
    return services[0]?.ID ?? null
  }

  /**
   * Services générés par l'expansion database rattachés à un NŒUD PARENT
   * (membres, consensus, endpoints) via le label bozando.database.parent.
   * Serve la résolution d'état AGRÉGÉE de l'observer (le nœud `database` reflète
   * la somme de ses services générés, pas un service isolé).
   */
  async listServiceIdsByDatabaseParent(parentId: string): Promise<string[]> {
    const services = (await this.docker.listServices({
      filters: { label: [`${LabelKeys.dbParent}=${parentId}`] },
    })) as { ID?: string }[]
    return services.map((s) => s.ID ?? "").filter(Boolean)
  }

  async getServiceMetrics(serviceId: string): Promise<ServiceMetrics> {
    const [svc, tasks] = await Promise.all([
      this.inspectService(serviceId),
      this.listServiceTasks(serviceId),
    ])
    const inspect = svc as {
      Spec?: { Name?: string; Mode?: { Replicated?: { Replicas?: number } } }
    }
    const desired = inspect.Spec?.Mode?.Replicated?.Replicas ?? 0
    const running = tasks.filter(
      (t) => (t as { Status?: { State?: string } }).Status?.State === "running"
    )

    const samples = await Promise.all(
      running.map(async (t) => {
        const cid = (t as { Status?: { ContainerStatus?: { ContainerID?: string } } })
          .Status?.ContainerStatus?.ContainerID
        if (!cid) return null
        return this.sampleContainerStats(cid)
      })
    )
    const valid = samples.filter((s): s is NonNullable<typeof s> => s !== null)
    const avgCpu = valid.length
      ? Math.round((valid.reduce((a, s) => a + s.cpuPct, 0) / valid.length) * 100) / 100
      : 0
    const sumMem = valid.reduce((a, s) => a + s.memBytes, 0)

    return {
      serviceId,
      name: inspect.Spec?.Name ?? serviceId,
      desiredReplicas: desired,
      runningReplicas: running.length,
      sampledTasks: valid.length,
      avgCpuPct: avgCpu,
      totalMemBytes: sumMem,
    }
  }

  // ── Réseaux (overlay attachable pour Swarm) ─────────────────────────────────

  async createNetwork(
    name: string,
    config: NetworkConfig,
    labels: Record<string, string>
  ) {
    return this.docker.createNetwork({
      Name: name,
      Driver: config.driver, // "overlay" par défaut
      Internal: config.internal,
      Attachable: config.attachable,
      // Labels gérés (bozando.*) APRÈS les labels utilisateur : jamais écrasables.
      Labels: { ...config.labels, ...labels },
      CheckDuplicate: true,
      ...(config.ipam?.subnet || config.ipam?.gateway
        ? {
            IPAM: {
              Config: [{ Subnet: config.ipam.subnet, Gateway: config.ipam.gateway }],
            },
          }
        : {}),
    })
  }

  async removeNetwork(id: string) {
    await this.docker.getNetwork(id).remove()
  }

  /**
   * Rattache un CONTENEUR (ex. le Caddy du cluster) à un réseau overlay.
   * Nécessaire pour la résolution DNS Swarm : Caddy ne peut joindre le service
   * cible par son nom (`boz_<slug>_<svc>`) que s'il partage un overlay du projet.
   * Idempotent — « already connected/exists » est toléré.
   */
  async connectContainerToNetwork(containerName: string, networkName: string): Promise<void> {
    try {
      await this.docker.getNetwork(networkName).connect({ Container: containerName })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/already (connected|exists)/i.test(msg)) {
        console.warn(`connectContainerToNetwork: ${containerName} déjà sur ${networkName} : ${msg}`)
        return
      }
      throw err
    }
  }

  /**
   * Garantit l'existence du réseau overlay SYSTÈME partagé `boz_system`.
   * Caddy (stack système) ET tout service exposé via une passerelle y sont
   * rattachés, pour que Caddy résolve `boz_<slug>_<svc>` par le DNS Swarm sur
   * tous les nœuds (le routing mesh seul ne suffit pas pour viser un service par
   * son nom sans port publié). Idempotent. Marqué bozando.system=true.
   */
  async ensureSystemNetwork(): Promise<string> {
    const name = "boz_system"
    const existing = await this.docker.listNetworks({ filters: { name: [name] } })
    const found = existing.find((n) => n.Name === name)
    if (found) return found.Id
    const net = await this.docker.createNetwork({
      Name: name,
      Driver: "overlay",
      Attachable: true,
      Labels: { "bozando.system": "true", "bozando.managed": "true" },
      CheckDuplicate: true,
    })
    return (net as { id: string }).id
  }

  // ── Volumes ──────────────────────────────────────────────────────────────────

  /** Retourne `null` sans rien créer si `config.external` (le volume existe déjà). */
  async createVolume(
    name: string,
    config: VolumeConfig,
    labels: Record<string, string>
  ) {
    if (config.external) return null
    return this.docker.createVolume({
      Name: name,
      Driver: config.driver,
      DriverOpts: config.driverOpts,
      // Labels gérés (bozando.*) APRÈS les labels utilisateur : jamais écrasables.
      Labels: { ...config.labels, ...labels },
    })
  }

  async removeVolume(name: string) {
    await this.docker.getVolume(name).remove()
  }

  // ── Docker Secrets (valeurs sensibles HORS labels) ──────────────────────────

  /**
   * Crée (ou remplace) un Docker Secret. La valeur est stockée chiffrée au repos
   * par Swarm (Raft) et montée en fichier read-only dans les services qui la
   * référencent — jamais dans un label ni l'env. Un secret existant est d'abord
   * supprimé (les secrets Swarm sont immuables : pas d'update de la donnée).
   * Retourne l'ID du secret. Tolère l'absence préalable.
   */
  async upsertSecret(name: string, value: string, labels: Record<string, string> = {}): Promise<string> {
    const existing = await this.docker.listSecrets({ filters: { name: [name] } })
    const found = (existing as { ID?: string; Spec?: { Name?: string } }[]).find(
      (s) => s.Spec?.Name === name
    )
    // Un secret référencé par un service ne peut pas être supprimé : l'appelant
    // doit d'abord détacher (redeploy sans la ref) — ici on tente, sinon on lève.
    if (found?.ID) {
      await this.docker.getSecret(found.ID).remove()
    }
    const res = await this.docker.createSecret({
      Name: name,
      Data: Buffer.from(value, "utf8").toString("base64"),
      Labels: { "bozando.managed": "true", ...labels },
    })
    return (res as { id?: string; ID?: string }).id ?? (res as { ID?: string }).ID ?? name
  }

  /** Liste les secrets gérés (noms seulement — la valeur n'est jamais lisible). */
  async listManagedSecrets() {
    const list = (await this.docker.listSecrets({
      filters: managedFilter(),
    })) as { ID?: string; Spec?: { Name?: string; Labels?: Record<string, string> } }[]
    return list.map((s) => ({
      id: s.ID ?? "",
      name: s.Spec?.Name ?? "",
      labels: s.Spec?.Labels ?? {},
    }))
  }

  async removeSecret(name: string): Promise<void> {
    const existing = await this.docker.listSecrets({ filters: { name: [name] } })
    const found = (existing as { ID?: string; Spec?: { Name?: string } }[]).find(
      (s) => s.Spec?.Name === name
    )
    if (found?.ID) {
      await this.docker.getSecret(found.ID).remove()
    }
  }

  // ── Services (cœur Swarm) ───────────────────────────────────────────────────

  /**
   * Traduit la `restartPolicy` du nœud (config + UI, cf. node-config.ts) en
   * `Condition` Swarm. `always`/`unless-stopped` → `any` (relance toujours, y
   * compris exit 0), `on-failure` → `on-failure`, `no` → `none` (one-shot :
   * nécessaire pour hello-world, sinon boucle infinie sur exit 0).
   */
  private static restartCondition(
    policy: ContainerConfig["restartPolicy"]
  ): "any" | "none" | "on-failure" {
    switch (policy) {
      case "on-failure":
        return "on-failure"
      case "no":
        return "none"
      default:
        return "any"
    }
  }

  /**
   * Construit la spec d'un service Swarm depuis la config conteneur. Partagé
   * entre create et update (garantit la cohérence).
   */
  private buildServiceSpec(
    name: string,
    config: ContainerConfig,
    labels: Record<string, string>,
    networkNames: string[],
    mounts: ServiceMount[],
    secretRefs: ResolvedSecret[] = []
  ): Docker.CreateServiceOptions {
    const image = `${config.image}:${config.tag}`
    const env = Object.entries(config.env).map(([k, v]) => `${k}=${v}`)

    const limits: { MemoryBytes?: number; NanoCPUs?: number } = {}
    if (config.resources?.memMb) limits.MemoryBytes = config.resources.memMb * 1024 * 1024
    if (config.resources?.cpus) limits.NanoCPUs = Math.round(config.resources.cpus * 1e9)

    const ports = config.ports
      .filter((p) => p.host !== undefined)
      .map((p) => ({
        Protocol: p.protocol,
        TargetPort: p.container,
        PublishedPort: p.host as number,
        PublishMode: "ingress" as const, // routing mesh
      }))

    return {
      Name: name,
      Labels: labels,
      TaskTemplate: {
        ContainerSpec: {
          Image: image,
          Env: env,
          Labels: labels, // labels aussi sur les tasks (pour les events)
          Command: config.cmd,
          Mounts: mounts.map((m) => ({
            Type: "volume" as const,
            Source: m.volumeName,
            Target: m.target,
            ReadOnly: m.readOnly ?? false,
          })),
          // Docker Secrets montés en fichiers read-only (/run/secrets/<name> par défaut).
          Secrets: secretRefs.map((s) => ({
            SecretID: s.id,
            SecretName: s.name,
            File: {
              Name: s.target ?? s.name,
              UID: "0",
              GID: "0",
              Mode: 0o444,
            },
          })),
        },
        Networks: networkNames.map((n) => ({ Target: n })),
        Resources: { Limits: limits },
        RestartPolicy: { Condition: DockerEngineService.restartCondition(config.restartPolicy) },
        // Placement Swarm (Constraints + Spread) — porté par les providers database
        // pour la distribution des membres . Omit quand absent : ne pas
        // polluer les specs des services existants qui n'en avaient pas.
        ...(config.placement
          ? {
              Placement: {
                Constraints: config.placement.constraints.length > 0 ? config.placement.constraints : undefined,
                Preferences: config.placement.spreadOver.map((descriptor) => ({
                  Spread: { SpreadDescriptor: descriptor },
                })),
              },
            }
          : {}),
      },
      Mode: { Replicated: { Replicas: config.replicas } },
      UpdateConfig: {
        Parallelism: config.updateParallelism,
        Delay: config.updateDelaySec * 1e9,
        Order: "start-first" as const, // démarre le neuf AVANT d'arrêter l'ancien = zero-downtime
        FailureAction: "rollback" as const,
      },
      // Mode d'endpoint Swarm :
      //  - `dnsrr` (DNS round-robin) quand AUCUN port n'est publié : le nom du
      //    service résout DIRECTEMENT les IP des tâches (conteneurs réels). C'est
      //    le mode requis pour un service exposé via la passerelle Caddy : Caddy
      //    proxy vers le nom du service et atteint la tâche vivante, même après
      //    redéploiement (nouvelle IP de tâche). Évite le piège de la VIP : quand
      //    le routing mesh est défaillant ou qu'un VIP périmé subsiste, la VIP ne
      //    répond pas et Caddy renvoie 502 alors que la tâche est saine.
      //  - `vip` (défaut Swarm) dès qu'on publie des ports : `dnsrr` est INTERDIT
      //    avec une publication de ports (Swarm refuse la création).
      EndpointSpec: {
        Mode: ports.length > 0 ? ("vip" as const) : ("dnsrr" as const),
        Ports: ports,
      },
    }
  }

  /**
   * Résout les références de secrets de la config en {id, name, target} exploitables
   * par la spec. Les secrets doivent exister (créés via upsertSecret) — sinon on
   * lève (déploiement bloqué tant que le secret n'est pas posé).
   */
  private async resolveSecretRefs(config: ContainerConfig): Promise<ResolvedSecret[]> {
    if (!config.secrets?.length) return []
    const all = (await this.docker.listSecrets({ filters: managedFilter() })) as {
      ID?: string
      Spec?: { Name?: string }
    }[]
    return config.secrets.map((ref) => {
      const match = all.find((s) => s.Spec?.Name === ref.secretName)
      if (!match?.ID) {
        throw new Error(`Docker Secret manquant : ${ref.secretName} (le créer avant de déployer)`)
      }
      return { id: match.ID, name: ref.secretName, target: ref.target }
    })
  }

  /** Crée un service. Tire l'image au préalable (sur ce nœud). */
  /**
   * Crée un service. NB : la DISPONIBILITÉ de l'image (pull selon la policy + garde
   * multi-nœuds) est de la responsabilité de l'APPELANT (workflow) via `ensureImage`,
   * appelé AVANT — pour pouvoir bloquer proprement sans créer un service à moitié.
   */
  async createService(
    name: string,
    config: ContainerConfig,
    labels: Record<string, string>,
    networkNames: string[] = [],
    mounts: ServiceMount[] = []
  ) {
    const secretRefs = await this.resolveSecretRefs(config)
    const spec = this.buildServiceSpec(name, config, labels, networkNames, mounts, secretRefs)
    return this.docker.createService(spec)
  }

  /**
   * GARDE-FOU œuf-poule : refuse toute opération destructive sur un service marqué
   * bozando.system=true (l'ops-panel lui-même tourne sur le manager qu'il pilote).
   * Lève si le service est système ; tolère le service absent (sera traité ailleurs).
   */
  private async assertNotSystem(serviceId: string): Promise<void> {
    try {
      const info = (await this.docker.getService(serviceId).inspect()) as {
        Spec?: { Labels?: Record<string, string> }
      }
      if (info.Spec?.Labels?.["bozando.system"] === "true") {
        throw new Error(`Opération refusée : service système (${serviceId})`)
      }
    } catch (err) {
      // Service absent : on laisse passer (l'appelant gère). On ne masque que le 404.
      if (err instanceof Error && err.message.startsWith("Opération refusée")) throw err
    }
  }

  /**
   * Met à jour un service existant (ROLLING UPDATE zero-downtime). Nécessite la
   * version courante du service (Swarm l'exige pour l'update optimiste).
   */
  async updateService(
    serviceId: string,
    name: string,
    config: ContainerConfig,
    labels: Record<string, string>,
    networkNames: string[] = [],
    mounts: ServiceMount[] = []
  ) {
    await this.assertNotSystem(serviceId)
    // Disponibilité image (pull/policy/garde) gérée par l'appelant via ensureImage.
    const service = this.docker.getService(serviceId)
    const info = (await service.inspect()) as { Version?: { Index?: number } }
    const secretRefs = await this.resolveSecretRefs(config)
    const spec = this.buildServiceSpec(name, config, labels, networkNames, mounts, secretRefs)
    return service.update({ ...spec, version: info.Version?.Index })
  }

  // ── Services système de l'ops-panel (mises à jour self-hosted) ────────────

  /**
   * Image des services système de la stack : `{registry}/{owner}/hullbay/{api,web}:*`.
   * Registre par défaut ghcr.io, surchargeable via IMAGE_REGISTRY (miroir /
   * registre local de test). Source de vérité pour reconnaître les services
   * qu'on a le droit de mettre à jour (et pour connaître le tag actuellement
   * déployé, nécessaire au rollback).
   */
  private hullbayImagePattern(): RegExp {
    const owner = process.env.GHCR_OWNER || "fotetsa"
    const registry = process.env.IMAGE_REGISTRY || "ghcr.io"
    return new RegExp(`^${escapeRegExp(registry)}/${owner}/hullbay/(api|web):.+$`)
  }
  /** Retourne les services Swarm de la stack hullbay (api + web), par composant. */
  async findHullbayServices(): Promise<Record<string, string>> {
    const services = (await this.docker.listServices()) as {
      ID?: string
      Spec?: { Name?: string; TaskTemplate?: { ContainerSpec?: { Image?: string } } }
    }[]
    const found: Record<string, string> = {}
    for (const s of services) {
      const image = s.Spec?.TaskTemplate?.ContainerSpec?.Image ?? ""
      const match = image.match(this.hullbayImagePattern())
      if (!match) continue
      const component = match[1]! as "api" | "web"
      const id = s.ID ?? ""
      const name = s.Spec?.Name ?? ""
      if (id) found[component] = id
      if (name && !found[`${component}:name`]) found[`${component}:name`] = name
    }
    return found
  }

  /** Tag d'image actuellement déployé pour un composant (`api` | `web`). */
  async currentSystemTag(component: "api" | "web"): Promise<string | null> {
    const found = await this.findHullbayServices()
    const id = found[component]
    if (!id) return null
    const info = (await this.docker.getService(id).inspect()) as {
      Spec?: { TaskTemplate?: { ContainerSpec?: { Image?: string } } }
    }
    const image = info.Spec?.TaskTemplate?.ContainerSpec?.Image ?? ""
    // Tag = dernier segment après le dernier '/' puis le dernier ':' — robuste aux
    // registres avec port (`host:port/owner/app:tag`).
    const lastPath = image.split("/").pop() ?? ""
    const idx = lastPath.lastIndexOf(":")
    return idx >= 0 ? lastPath.slice(idx + 1) || null : null
  }

  /**
   * Met à jour UNIQUEMENT l'image d'un service de la stack hullbay (rolling
   * update Swarm : start-first, l'ancien ne s'arrête qu'une fois le neuf sain).
   *
   * Contourne délibérément `assertNotSystem` (l'ops-panel SE met à jour) mais de
   * façon contrôlée : refuse tout service dont l'image n'est pas
   * `ghcr.io/{owner}/hullbay/{api|web}:*` — jamais un autre service système.
   */
  async updateSystemServiceImage(
    component: "api" | "web",
    image: string,
  ): Promise<void> {
    const found = await this.findHullbayServices()
    const serviceId = found[component]
    if (!serviceId) {
      throw new Error(
        `Service hullbay '${component}' introuvable dans Swarm (stack non déployée ?)`,
      )
    }
    const service = this.docker.getService(serviceId)
    const info = (await service.inspect()) as {
      Version?: { Index?: number }
      Spec?: Docker.CreateServiceOptions & {
        TaskTemplate?: { ContainerSpec?: { Image?: string } }
      }
    }
    if (!info.Spec) throw new Error(`Service '${component}' : spec illisible`)
    const currentImage = info.Spec.TaskTemplate?.ContainerSpec?.Image ?? ""
    if (!currentImage.match(this.hullbayImagePattern())) {
      throw new Error(
        `Refus : le service '${component}' n'est pas une image hullbay (${currentImage})`,
      )
    }
    // Défense en profondeur : l'image CIBLE doit aussi être une image hullbay du
    // bon composant (on ne redéploie jamais une image arbitraire sur la stack).
    const targetMatch = image.match(this.hullbayImagePattern())
    if (!targetMatch || targetMatch[1] !== component) {
      throw new Error(
        `Refus : l'image cible doit être ghcr.io/{owner}/hullbay/${component}:<tag> (${image})`,
      )
    }
    const spec: Docker.CreateServiceOptions = {
      ...info.Spec,
      TaskTemplate: {
        ...info.Spec.TaskTemplate,
        ContainerSpec: {
          ...info.Spec.TaskTemplate?.ContainerSpec,
          Image: image,
        },
        // ForceUpdate : force Swarm à recréer la tâche MÊME si l'image est
        // identique à l'actuelle. Sans ça, un redeploy du même tag est un no-op
        // (pas de nouveau conteneur) → l'API ne redémarre jamais → la
        // finalisation au boot (finalizeOrphanUpdates) ne s'exécute pas et
        // l'update reste bloquée en « running ».
        ForceUpdate: 1,
      },
    }
    await service.update({ ...spec, version: info.Version?.Index })
  }

  /**
   * Ajuste UNIQUEMENT le nombre de replicas d'un service, en préservant le reste
   * de la spec (image, réseaux, mounts, ports). Utilisé par l'auto-scaler : pas de
   * re-pull ni de rolling sur le conteneur, juste add/remove de tasks. Idempotent
   * (no-op si déjà au bon nombre). Retourne le nombre de replicas effectif.
   */
  async scaleService(serviceId: string, replicas: number): Promise<number> {
    await this.assertNotSystem(serviceId)
    const service = this.docker.getService(serviceId)
    const info = (await service.inspect()) as {
      Version?: { Index?: number }
      Spec?: Docker.CreateServiceOptions & {
        Mode?: { Replicated?: { Replicas?: number } }
      }
    }
    const current = info.Spec?.Mode?.Replicated?.Replicas
    if (!info.Spec || current === replicas) return current ?? replicas
    const spec: Docker.CreateServiceOptions = {
      ...info.Spec,
      Mode: { Replicated: { Replicas: replicas } },
    }
    await service.update({ ...spec, version: info.Version?.Index })
    return replicas
  }

  /** Supprime un service. Tolérant si déjà absent. Refuse les services système. */
  async removeService(idOrName: string) {
    await this.assertNotSystem(idOrName)
    try {
      await this.docker.getService(idOrName).remove()
    } catch {
      // déjà supprimé
    }
  }

  /**
   * Garantit la disponibilité d'une image selon la pull policy (calquée K8s).
   * Retourne `{ pulled }` : true si l'image vient d'être tirée du registre, false si
   * elle est servie depuis le cache local (info utilisée par le garde multi-nœuds).
   *
   *  - Always       : pull obligatoire. Échec pull → ImageUnavailableError (PAS de
   *                   fallback local : on ne sert jamais un `latest` local périmé).
   *  - IfNotPresent : présente localement → pas de pull (pulled=false) ; sinon pull,
   *                   et si le pull échoue ET absente → ImageUnavailableError.
   *  - Never        : jamais de pull ; absente localement → ImageUnavailableError.
   */
  async ensureImage(image: string, policy: PullPolicy): Promise<{ pulled: boolean }> {
    if (policy === "Never") {
      if (await this.imageExistsLocally(image)) return { pulled: false }
      throw new ImageUnavailableError(
        `Image absente localement et pull désactivé (policy Never) : ${image}`
      )
    }

    if (policy === "IfNotPresent" && (await this.imageExistsLocally(image))) {
      return { pulled: false }
    }

    // Always, ou IfNotPresent avec image absente : on tente le pull.
    try {
      await this.pullImage(image)
      return { pulled: true }
    } catch (err) {
      // IfNotPresent : tolère un pull raté si l'image existe quand même localement.
      if (policy === "IfNotPresent" && (await this.imageExistsLocally(image))) {
        return { pulled: false }
      }
      const detail = err instanceof Error ? err.message : String(err)
      throw new ImageUnavailableError(
        `Impossible de récupérer l'image ${image} : ${detail}. ` +
          `Vérifie le nom de l'image, ou enregistre les identifiants du registre (page Registres) si elle est privée.`
      )
    }
  }

  /** Vrai si l'image est déjà présente dans le démon local. */
  private async imageExistsLocally(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect()
      return true
    } catch {
      return false
    }
  }

  /** Tire l'image (avec auth registre si un resolver est configuré). Brique bas niveau. */
  private async pullImage(image: string): Promise<void> {
    const authconfig = this.authResolver ? await this.authResolver(image) : null
    const opts = authconfig ? { authconfig } : {}
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, opts, (err: unknown, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err ?? new Error("pull: pas de stream"))
        this.docker.modem.followProgress(stream, (doneErr: unknown) =>
          doneErr ? reject(doneErr) : resolve()
        )
      })
    })
  }

  // ── Logs (stream, agrégé des tasks du service) ──────────────────────────────

  async streamLogs(serviceId: string, tail = 200) {
    return this.docker.getService(serviceId).logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail,
    }) as unknown as NodeJS.ReadableStream
  }
}
