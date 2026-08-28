import {
  buildBozandoLabels,
  parseNodeConfig,
  effectivePullPolicy,
  LabelKeys,
  databaseOwnershipLabels,
  isRetainedDataVolume,
  type ProjectGraph,
  type Node,
  type Edge,
  type EdgeSummary,
  type ContainerConfig,
  type NetworkConfig,
  type VolumeConfig,
  type GatewayConfig,
} from "@hullbay/shared"
import { runWorkflow, type Step } from "../lib/workflow"
import {
  DockerEngineService,
  ImageUnavailableError,
} from "../modules/docker-engine/service"
import { exposureService } from "../modules/exposure/service"
import { TunnelError } from "../lib/ssh-tunnel"
import { invalidateDockerClient } from "../modules/docker-engine/client"
import { ReconcilerService } from "../modules/reconciler/service"
import { registryService } from "../modules/registry/service"
import { prisma } from "../lib/prisma"
import { expandDatabaseGraph, DatabaseValidationError } from "../modules/database"

/**
 * Erreur MÉTIER de déploiement (image indisponible, garde multi-nœuds, secret
 * manquant…) : prévisible et actionnable par l'utilisateur. La route la traduit en
 * 422 + message propre, au lieu d'un 500 (réservé aux vrais bugs).
 */
export class DeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeployError"
  }
}

/**
 * Détecte si une image provient de Docker Hub (pas de registry explicite).
 * Convention Docker : la première partie du nom sans "." = Docker Hub.
 * Exemples : "postgres:16.3" → true, "ghcr.io/fotetsa/api:v1" → false
 */
function isDockerHubImage(image: string): boolean {
  const firstPart = (image.split(":")[0]?.split("/")[0]) ?? ""
  return !firstPart.includes(".")
}

/**
 * Workflow de déploiement d'un projet (DOCKER SWARM), en STEPS avec COMPENSATION.
 * Ordre : réseaux(overlay) -> volumes -> services (diff create/update rolling +
 * montage volumes + réseaux déclarés) -> passerelles (routes Caddy). Si un step
 * échoue, les steps déjà exécutés sont compensés en ordre inverse.
 */

export interface DeployInput {
  graph: ProjectGraph
  createdBy?: string
}

export type DeployShared = {
  log: string[]
  networkIdByNodeId: Map<string, string>
  createdServiceIds: string[]
  createdNetworkIds: string[]
  createdGateways: { nodeName: string }[]
  /** Expansion database du graphe déployé : ownership des ressources générées. */
  db: ReturnType<typeof expandDatabaseGraph>
  /**
   * État déployé à persister en base APRÈS succès (sinon node.dockerId reste null
   * et le badge "à déployer" ne disparaît jamais). Pour les nœuds non-conteneur
   * (réseau/volume/passerelle), il n'y a pas de cycle de vie observable par events
   * (ils sont "up" dès qu'ils existent) : on fixe actualState="running" ici. Les
   * conteneurs sont aussi marqués running optimistiquement, puis l'observer prend
   * le relais en temps réel (running/exited/...).
   */
  deployed: Map<string, { dockerId?: string; actualState: "running" }>
  engine: DockerEngineService
  reconciler: ReconcilerService
}

// Resolver d'auth registre : déduit le registre du nom d'image (1er segment si
// host avec point ou port), récupère l'authconfig chiffré du registre correspondant.
// const docker = new DockerEngineService(undefined, async (image) => {
//   const host = image.includes("/") ? image.split("/")[0] : ""
//   const registry = host && (host.includes(".") || host.includes(":")) ? host : "docker.io"
//   const auth = await registryService.getAuthConfig(registry)
//   return auth ?? null
// })
// const reconciler = new ReconcilerService(docker)

function resourceName(slug: string, nodeName: string) {
  return `boz_${slug}_${nodeName}`
}

function outgoing(graph: ProjectGraph, nodeId: string): EdgeSummary[] {
  return graph.edges
    .filter((e: Edge) => e.sourceNodeId === nodeId)
    .map((e: Edge) => {
      const target = graph.nodes.find((n) => n.id === e.targetNodeId)
      return {
        targetNodeName: target?.name ?? "",
        kind: e.kind ?? "network",
        config: (e.config as Record<string, unknown> | null) ?? null
      }
    })
}

function labelsFor(input: DeployInput, node: Node, db: ReturnType<typeof expandDatabaseGraph>) {
  const labels = buildBozandoLabels({
    projectId: input.graph.id,
    projectSlug: input.graph.slug,
    node,
    outgoingEdges: outgoing(input.graph, node.id),
    createdBy: input.createdBy,
  })
  // Ownership database des ressources GÉNÉRÉES (observer/rebuild/rétention/UI).
  const own = db.ownership.get(node.id)
  if (own) {
    // Labels bozando.database.* : rétention honorée (retainDataOnDelete). Aucun
    // label dbData posé si opt-out → volume supprimable par les 3 chemins.
    Object.assign(labels, databaseOwnershipLabels({
      parentNodeId: own.parentNodeId,
      parentNodeName: own.parentName,
      parentConfig: own.parentConfig,
      role: own.role,
      index: own.index,
      engine: own.engine,
      data: own.data,
      retainDataOnDelete: own.parentConfig.retainDataOnDelete,
    }))
  }
  return labels
}

// ── Steps ──────────────────────────────────────────────────────────────────

const networksStep: Step<DeployInput> = {
  name: "networks",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    // Réseau système partagé (Caddy <-> services exposés) si le projet a des passerelles.
    if (input.graph.nodes.some((n) => n.type === "gateway")) {
      await s.engine.ensureSystemNetwork()
      s.log.push("réseau système boz_system garanti (exposition)")
    }
    const existing = await s.engine.listManagedNetworks()
    for (const node of input.graph.nodes.filter((n) => n.type === "network")) {
      const name = resourceName(slug, node.name)
      const already = existing.find((n) => n.Name === name)
      if (already) {
        s.networkIdByNodeId.set(node.id, already.Id)
        s.deployed.set(node.id, { dockerId: already.Id, actualState: "running" })
        s.log.push(`réseau ${name} déjà présent`)
        continue
      }
      const net = await s.engine.createNetwork(
        name,
        parseNodeConfig("network", node.config) as NetworkConfig,
        labelsFor(input, node, s.db)
      )
      const id = (net as { id: string }).id
      s.networkIdByNodeId.set(node.id, id)
      s.createdNetworkIds.push(id)
      s.deployed.set(node.id, { dockerId: id, actualState: "running" })
      s.log.push(`réseau ${name} créé`)
    }
  },
  compensate: async (_input, ctx) => {
    const s = ctx.shared as DeployShared
    for (const id of s.createdNetworkIds.reverse()) {
      await s.engine.removeNetwork(id).catch(() => {})
    }
  },
}

export const volumesStep: Step<DeployInput> = {
  name: "volumes",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    const existing = await s.engine.listManagedVolumes();

    // ── Suppression des volumes ORPHELINS (présents dans Docker mais plus dans le
    // graphe) — symétrique du `remove` des services "hors graphe". Sans ça, un
    // volume retiré du canvas survit indéfiniment dans Docker (le step ne faisait
    // que créer), et réapparaît à chaque déploiement. On ne touche QU'aux volumes
    // managés de CE projet (filtre projectId), jamais aux volumes système/externes.
    // GARDE RÉTENTION : un volume marqué bozando.database.data=true (données d'une
    // base) n'est JAMAIS supprimé automatiquement  — la suppression
    // n'efface pas les données sans politique explicite de l'utilisateur.
    const wantedNames = new Set(
      input.graph.nodes
        .filter((n) => n.type === "volume")
        .map((n) => resourceName(slug, n.name))
    )
    for (const v of existing) {
      const labels = v.Labels ?? {}
      if (labels[LabelKeys.projectId] !== input.graph.id) continue
      if (labels[LabelKeys.system] === "true") continue
      if (isRetainedDataVolume(labels)) continue
      if (wantedNames.has(v.Name)) continue
      try {
        await s.engine.removeVolume(v.Name);
        s.log.push(`volume ${v.Name} supprimé (hors graphe)`)
      } catch {
        // Volume encore monté par un service pas encore reconcilié, ou déjà parti :
        // tolérant (le prochain déploiement, après mise à jour du service, réessaiera).
        s.log.push(`volume ${v.Name} non supprimé (encore utilisé ?) — réessai au prochain déploiement`)
      }
    }

    for (const node of input.graph.nodes.filter((n) => n.type === "volume")) {
      const cfg = parseNodeConfig("volume", node.config) as VolumeConfig
      if (cfg.external) {
        s.deployed.set(node.id, { actualState: "running" })
        s.log.push(`volume externe ${cfg.externalName} référencé (non géré)`)
        continue
      }
      const name = resourceName(slug, node.name)
      if (existing.find((v) => v.Name === name)) {
        s.deployed.set(node.id, { actualState: "running" })
        s.log.push(`volume ${name} déjà présent`)
        continue
      }
      await s.engine.createVolume(name, cfg, labelsFor(input, node, s.db));
      s.deployed.set(node.id, { actualState: "running" })
      s.log.push(`volume ${name} créé`)
    }
  },
}

export const secretsStep: Step<DeployInput> = {
  name: "secrets",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const generated = s.db.generatedSecrets
    // Pas de secrets générés  ; le step reste prêt pour HA.
    if (generated.length === 0) return
    // Config-secrets générés par l'expansion (haproxy.cfg, sentinel.conf…). Les
    // providers nomment déjà par `-<hash8>` (contenu) : un nom IDENTIQUE = même
    // contenu → skip (pas de delete+recreate ; les secrets Swarm immuables seraient
    // supprimés alors qu'un service en cours les référence). Un changement de
    // contenu produit un nom NEUF avant le rolling update.
    const existing = await s.engine.listManagedSecrets()
    const currentNames = new Set(generated.map((g) => g.name))
    for (const g of generated) {
      const already = existing.find(
        (sec) =>
          sec.name === g.name &&
          sec.labels["bozando.database.generated"] === "true" &&
          sec.labels[LabelKeys.projectId] === input.graph.id
      )
      if (already) {
        s.log.push(`secret généré ${g.name} inchangé (skip)`)
        continue
      }
      await s.engine.upsertSecret(g.name, g.data, {
        [LabelKeys.managed]: "true",
        "bozando.database.generated": "true",
        [LabelKeys.projectId]: input.graph.id,
        [LabelKeys.projectSlug]: input.graph.slug,
      })
      s.log.push(`secret généré ${g.name} posé`)
    }
    // Orphelins : générés pour CE projet mais non référencés par le nouveau nom
    // (contenu changé). Suppression tolérante — un secret encore monté par un
    // service pré-rolling ne se supprime pas (Swarm) : réessai au prochain deploy.
    for (const sec of existing) {
      const mine =
        sec.labels["bozando.database.generated"] === "true" &&
        sec.labels[LabelKeys.projectId] === input.graph.id
      if (!mine || currentNames.has(sec.name)) continue
      try {
        await s.engine.removeSecret(sec.name)
        s.log.push(`ancien secret généré ${sec.name} supprimé (contenu changé)`)
      } catch {
        s.log.push(`secret ${sec.name} retenu (encore monté ?) — réessai au prochain déploiement`)
      }
    }
  },
}

export const servicesStep: Step<DeployInput> = {
  name: "services",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    const plan = await s.reconciler.plan(input.graph)

    // Nombre de nœuds du cluster : sert au garde-fou "image locale non déployable
    // sur multi-nœuds". Compté une fois pour ce déploiement.
    const nodeCount = (await s.engine.listNodes()).length;

    for (const action of plan.actions) {
      if (action.kind === "remove") {
        await s.engine.removeService(action.dockerId);
        s.log.push(`service ${action.name} supprimé (hors graphe)`)
        continue
      }
      if (action.kind === "noop") {
        s.deployed.set(action.node.id, { dockerId: action.existingId, actualState: "running" })
        s.log.push(`service ${action.node.name} inchangé`)
        continue
      }
      const node = action.node
      const name = resourceName(slug, node.name)
      const cfg = parseNodeConfig("container", node.config) as ContainerConfig
      const networks = networkNamesFor(input.graph, node, slug)
      const mounts = volumeMountsFor(input.graph, node)
      const labels = labelsFor(input, node, s.db)

      // If railpack is configured on the container, build the image from the repo
      let image: string
      if ((cfg as any).railpack) {
        const rp = (cfg as any).railpack as { repoUrl: string; branch?: string }
        s.log.push(`Railpack: build image from ${rp.repoUrl}${rp.branch ? `@${rp.branch}` : ""}`)
        const built = await s.engine.buildImageFromRepo(rp.repoUrl, { branch: rp.branch })
        // Attempt to distribute the image to the cluster (stub may be no-op)
        await s.engine.distributeImageToCluster(built.imageTag)
        image = built.imageTag
      } else {
        // 1) Disponibilité de l'image SELON LA POLICY (avant toute création de service).
        image = `${cfg.image}:${cfg.tag}`
      }
      const policy = effectivePullPolicy(cfg)
      let pulled: boolean
      try {
        ;({ pulled } = await s.engine.ensureImage(image, policy));
      } catch (err) {
        if (err instanceof ImageUnavailableError) throw new DeployError(err.message)
        throw err
      }

      // 2) Garde multi-nœuds : une image servie depuis le local (pas pull) n'est pas
      //    déployable de façon fiable sur un cluster (un autre nœud ne l'a pas).
      //    Exception : images Docker Hub (pas de registry explicite) — Swarm les
      //    tirera automatiquement sur le nœud cible.
      if (!pulled && nodeCount > 1 && !isDockerHubImage(image)) {
        throw new DeployError(
          `Image locale « ${image} » (policy ${policy}) non déployable sur un cluster ` +
            `multi-nœuds (${nodeCount} nœuds) : pousse-la sur un registre (ex. ghcr.io/...) ` +
            `et référence-la par ce nom, ou enregistre ses identifiants dans Registres.`
        )
      }

      try {
        if (action.kind === "update") {
          // ROLLING UPDATE zero-downtime (start-first) — pas de remove+create.
          await s.engine.updateService(
            action.existingId,
            name,
            cfg,
            labels,
            networks,
            mounts,
          );
          s.deployed.set(node.id, { dockerId: action.existingId, actualState: "running" })
          s.log.push(`service ${node.name} mis à jour (rolling, ${cfg.replicas} replicas)`)
        } else {
          const svc = await s.engine.createService(
            name,
            cfg,
            labels,
            networks,
            mounts,
          );
          const id = (svc as { id: string }).id
          s.createdServiceIds.push(id)
          s.deployed.set(node.id, { dockerId: id, actualState: "running" })
          s.log.push(`service ${node.name} créé (${cfg.replicas} replicas)`)
        }
      } catch (err) {
        // Secret manquant = erreur métier actionnable (l'utilisateur doit créer le
        // secret avant de déployer) → 422 via DeployError.
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.startsWith("Docker Secret manquant")) throw new DeployError(msg)
        throw err
      }
    }
  },
  compensate: async (_input, ctx) => {
    const s = ctx.shared as DeployShared
    // On ne défait que les services CRÉÉS dans ce déploiement (pas les updates).
    for (const id of s.createdServiceIds.reverse()) {
      await s.engine.removeService(id).catch(() => {});
    }
  },
}

const gatewaysStep: Step<DeployInput> = {
  name: "gateways",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug

    // Caddy du cluster doit être sur les overlays du projet pour résoudre le nom
    // de service cible (DNS Swarm). Rattachement auto, idempotent — seulement si
    // le projet expose réellement une passerelle.
    if (input.graph.nodes.some((n) => n.type === "gateway")) {
      const caddyContainer = "hullbay-caddy"
      const overlays = [
        "boz_system",
        ...input.graph.nodes
          .filter((n) => n.type === "network")
          .map((n) => resourceName(slug, n.name)),
      ]
      for (const overlay of overlays) {
        await s.engine
          .connectContainerToNetwork(caddyContainer, overlay)
          .catch((err) => {
            const detail = err instanceof Error ? err.message : String(err)
            s.log.push(`Caddy non rattaché à ${overlay} (best effort) : ${detail}`)
          })
      }
    }

    for (const node of input.graph.nodes.filter((n) => n.type === "gateway")) {
      const cfg = parseNodeConfig("gateway", node.config) as GatewayConfig;
      // La cible = le conteneur lié par un edge "gateway" (ou le 1er conteneur lié).
      const target = input.graph.edges
        .filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id)
        .map((e) => {
          const otherId =
            e.sourceNodeId === node.id ? e.targetNodeId : e.sourceNodeId;
          return input.graph.nodes.find(
            (n) => n.id === otherId && n.type === "container",
          );
        })
        .find(Boolean);
      if (!target) {
        s.log.push(`passerelle ${node.name} ignorée (aucun conteneur lié)`);
        continue;
      }
      const upstreamHost = resourceName(slug, target.name);
      // NOTE : exposureService parle au Caddy du serveur SYSTÈME (hullbay lui-même),
      // pas au cluster du projet. Si le projet est sur un cluster DISTANT, cette route
      // ne pourra pas fonctionner tel quel (Caddy système ne peut pas résoudre un
      // conteneur d'un autre Swarm par son nom). Point à creuser à part, pas bloquant
      // pour ce refactor précis.
      await exposureService.upsertRoute(input.graph.clusterId, slug, node.name, cfg, upstreamHost);
      s.createdGateways.push({ nodeName: node.name });
      // Une passerelle = une route Caddy : "up" dès qu'elle existe (pas de cycle de
      // vie observable par events Docker comme un conteneur). On la marque running.
      s.deployed.set(node.id, { actualState: "running" });
      s.log.push(
        `passerelle ${cfg.domain} -> ${target.name}:${cfg.targetPort}`,
      );
    }
  },
  compensate: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    for (const g of s.createdGateways.reverse()) {
      await exposureService.deleteRoute(input.graph.clusterId, input.graph.slug, g.nodeName).catch(() => {})
    }
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function volumeMountsFor(graph: ProjectGraph, containerNode: Node) {
  const mounts: { volumeName: string; target: string; readOnly?: boolean }[] = []
  for (const e of graph.edges) {
    if (e.kind !== "volume") continue
    const isSource = e.sourceNodeId === containerNode.id
    const isTarget = e.targetNodeId === containerNode.id
    if (!isSource && !isTarget) continue
    const otherId = isSource ? e.targetNodeId : e.sourceNodeId
    const vol = graph.nodes.find((n) => n.id === otherId && n.type === "volume")
    if (!vol) continue
    const volCfg = parseNodeConfig("volume", vol.config) as VolumeConfig
    const edgeCfg = (e.config as { mountPath?: string; readOnly?: boolean } | null) ?? {}
    mounts.push({
      // Volume externe : référence le nom EXACT préexistant, pas le préfixe managé.
      volumeName: volCfg.external ? volCfg.externalName! : `boz_${graph.slug}_${vol.name}`,
      target: edgeCfg.mountPath || `/data/${vol.name}`,
      readOnly: edgeCfg.readOnly,
    })
  }
  return mounts
}

/**
 * Noms des réseaux Docker (overlay) auxquels rattacher le service d'un conteneur,
 * d'après ses edges "network". En Swarm, on DÉCLARE les réseaux dans la spec du
 * service (TaskTemplate.Networks) — pas d'attache impérative post-création.
 */
function networkNamesFor(graph: ProjectGraph, node: Node, slug: string): string[] {
  const names: string[] = []
  for (const edge of outgoing(graph, node.id)) {
    if (edge.kind !== "network") continue
    const targetNode = graph.nodes.find(
      (n) => n.name === edge.targetNodeName && n.type === "network"
    )
    if (targetNode) names.push(`boz_${slug}_${targetNode.name}`)
  }
  // Si une passerelle cible ce conteneur, il doit joindre l'overlay système pour
  // que Caddy (qui y est aussi rattaché) résolve son nom de service par DNS Swarm.
  const exposed = graph.edges.some((e) => {
    if (e.kind !== "gateway") return false
    const otherId = e.sourceNodeId === node.id ? e.targetNodeId : e.sourceNodeId
    const isPair = e.sourceNodeId === node.id || e.targetNodeId === node.id
    const gw = graph.nodes.find((n) => n.id === otherId && n.type === "gateway")
    return isPair && Boolean(gw)
  })
  if (exposed) names.push("boz_system")
  return names
}

// ── Exécution ────────────────────────────────────────────────────────────────

export async function deployProjectWorkflow(input: DeployInput) {
  // Purge le client Docker mis en cache pour ce cluster : force la création
  // d'un tunnel SSH frais avec un port local neuf (évite ECONNREFUSED si le
  // tunnel précédent a été refermé entre deux appels).
  invalidateDockerClient(input.graph.clusterId)

  // EXPANSION database : le graphe persisté (avec nœuds `database` de composition)
  // devient le graphe déployable (membres/consensus/endpoints/réseau/volumes).
  // En mémoire uniquement — jamais persisté . Une topologie invalide ou
  // un moteur non implémenté bloquent le déploiement AVANT toute action Docker.
  let expanded: ReturnType<typeof expandDatabaseGraph>
  try {
    expanded = expandDatabaseGraph(input.graph)
  } catch (err) {
    if (err instanceof DatabaseValidationError) {
      throw new DeployError(err.message)
    }
    throw err
  }

  const engine = await DockerEngineService.forCluster(
    input.graph.clusterId,
    async (image) => {
      const host = image.includes("/") ? image.split("/")[0] : "";
      const registry =
        host && (host.includes(".") || host.includes(":")) ? host : "docker.io";
      const auth = await registryService.getAuthConfig(registry);
      return auth ?? null;
    },
  );
  const reconciler = new ReconcilerService(engine);

  const shared: DeployShared = {
    log: [],
    networkIdByNodeId: new Map(),
    createdServiceIds: [],
    createdNetworkIds: [],
    createdGateways: [],
    db: expanded,
    deployed: new Map(),
    engine,
    reconciler,
  };
  const result = await runWorkflow<DeployInput>(
    "deploy-project",
    [networksStep, volumesStep, secretsStep, servicesStep, gatewaysStep],
    { ...input, graph: expanded.graph },
    {},
    shared as unknown as Record<string, unknown>,
  );
  if (!result.ok) {
    // Préserve le type d'erreur d'origine (DeployError → 422 côté route, TunnelError
    // → 409/502/504) ; pour les autres, message brut prefixé (vrai bug → 500).
    if (result.errorCause instanceof DeployError) throw result.errorCause
    if (result.errorCause instanceof TunnelError) throw result.errorCause
    throw new Error(result.error || "déploiement échoué")
  }

  // Persiste l'état déployé : sans ça node.dockerId reste null → le badge
  // "à déployer" ne disparaît jamais, et les nœuds sans events (réseau/volume/
  // passerelle) restent gris. L'observer (conteneurs) affinera ensuite en live.
  const final = result.shared as DeployShared
  await Promise.all(
    [...final.deployed.entries()].map(([nodeId, st]) =>
      prisma.node
        .update({
          where: { id: nodeId },
          data: {
            actualState: st.actualState,
            ...(st.dockerId ? { dockerId: st.dockerId } : {}),
          },
        })
        .catch(() => {})
    )
  )

  // Persiste l'état des nœuds PARENTS database : l'expansion remplace chaque
  // nœud database par des membres synthétiques (ids éphémères absents de la DB).
  // Le deployed map ne contient donc JAMAIS l'id du parent → son actualState reste
  // null → badge "à déployer" persistant. On le fixe ici directement. Les clés de
  // `ownership` sont des ids synthétiques (`db::<parent>::…`) : le vrai id parent
  // est dans les VALEURS (own.parentNodeId) — extrait puis dédupliqué.
  const parentIds = new Set<string>()
  for (const own of expanded.ownership.values()) {
    parentIds.add(own.parentNodeId)
  }
  for (const parentNodeId of parentIds) {
    await prisma.node
      .update({
        where: { id: parentNodeId },
        data: { actualState: "running" },
      })
      .catch(() => {})
  }

  return final.log
}
