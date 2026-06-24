import {
  buildBozandoLabels,
  parseNodeConfig,
  effectivePullPolicy,
  LabelKeys,
  type ProjectGraph,
  type Node,
  type Edge,
  type EdgeSummary,
  type ContainerConfig,
  type NetworkConfig,
  type VolumeConfig,
  type GatewayConfig,
} from "@bozando-ops/shared"
import { runWorkflow, type Step } from "../lib/workflow"
import {
  DockerEngineService,
  ImageUnavailableError,
} from "../modules/docker-engine/service"
import { exposureService } from "../modules/exposure/service"
import { ReconcilerService } from "../modules/reconciler/service"
import { registryService } from "../modules/registry/service"
import { prisma } from "../lib/prisma"

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
 * Workflow de déploiement d'un projet (DOCKER SWARM), en STEPS avec COMPENSATION.
 * Ordre : réseaux(overlay) -> volumes -> services (diff create/update rolling +
 * montage volumes + réseaux déclarés) -> passerelles (routes Caddy). Si un step
 * échoue, les steps déjà exécutés sont compensés en ordre inverse.
 */

export interface DeployInput {
  graph: ProjectGraph
  createdBy?: string
}

type DeployShared = {
  log: string[]
  networkIdByNodeId: Map<string, string>
  createdServiceIds: string[]
  createdNetworkIds: string[]
  createdGateways: { nodeName: string }[]
  /**
   * État déployé à persister en base APRÈS succès (sinon node.dockerId reste null
   * et le badge "à déployer" ne disparaît jamais). Pour les nœuds non-conteneur
   * (réseau/volume/passerelle), il n'y a pas de cycle de vie observable par events
   * (ils sont "up" dès qu'ils existent) : on fixe actualState="running" ici. Les
   * conteneurs sont aussi marqués running optimistiquement, puis l'observer prend
   * le relais en temps réel (running/exited/...).
   */
  deployed: Map<string, { dockerId?: string; actualState: "running" }>
}

// Resolver d'auth registre : déduit le registre du nom d'image (1er segment si
// host avec point ou port), récupère l'authconfig chiffré du registre correspondant.
const docker = new DockerEngineService(undefined, async (image) => {
  const host = image.includes("/") ? image.split("/")[0] : ""
  const registry = host && (host.includes(".") || host.includes(":")) ? host : "docker.io"
  const auth = await registryService.getAuthConfig(registry)
  return auth ?? null
})
const reconciler = new ReconcilerService(docker)

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
        config: (e.config as Record<string, unknown> | null) ?? null,
      }
    })
}

function labelsFor(input: DeployInput, node: Node) {
  return buildBozandoLabels({
    projectId: input.graph.id,
    projectSlug: input.graph.slug,
    node,
    outgoingEdges: outgoing(input.graph, node.id),
    createdBy: input.createdBy,
  })
}

// ── Steps ──────────────────────────────────────────────────────────────────

const networksStep: Step<DeployInput> = {
  name: "networks",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    // Réseau système partagé (Caddy <-> services exposés) si le projet a des passerelles.
    if (input.graph.nodes.some((n) => n.type === "gateway")) {
      await docker.ensureSystemNetwork()
      s.log.push("réseau système boz_system garanti (exposition)")
    }
    const existing = await docker.listManagedNetworks()
    for (const node of input.graph.nodes.filter((n) => n.type === "network")) {
      const name = resourceName(slug, node.name)
      const already = existing.find((n) => n.Name === name)
      if (already) {
        s.networkIdByNodeId.set(node.id, already.Id)
        s.deployed.set(node.id, { dockerId: already.Id, actualState: "running" })
        s.log.push(`réseau ${name} déjà présent`)
        continue
      }
      const net = await docker.createNetwork(
        name,
        parseNodeConfig("network", node.config) as NetworkConfig,
        labelsFor(input, node)
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
      await docker.removeNetwork(id).catch(() => {})
    }
  },
}

const volumesStep: Step<DeployInput> = {
  name: "volumes",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    const existing = await docker.listManagedVolumes()

    // ── Suppression des volumes ORPHELINS (présents dans Docker mais plus dans le
    // graphe) — symétrique du `remove` des services "hors graphe". Sans ça, un
    // volume retiré du canvas survit indéfiniment dans Docker (le step ne faisait
    // que créer), et réapparaît à chaque déploiement. On ne touche QU'aux volumes
    // managés de CE projet (filtre projectId), jamais aux volumes système/externes.
    const wantedNames = new Set(
      input.graph.nodes
        .filter((n) => n.type === "volume")
        .map((n) => resourceName(slug, n.name))
    )
    for (const v of existing) {
      const labels = v.Labels ?? {}
      if (labels[LabelKeys.projectId] !== input.graph.id) continue
      if (labels[LabelKeys.system] === "true") continue
      if (wantedNames.has(v.Name)) continue
      try {
        await docker.removeVolume(v.Name)
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
      await docker.createVolume(name, cfg, labelsFor(input, node))
      s.deployed.set(node.id, { actualState: "running" })
      s.log.push(`volume ${name} créé`)
    }
  },
}

const servicesStep: Step<DeployInput> = {
  name: "services",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    const plan = await reconciler.plan(input.graph)

    // Nombre de nœuds du cluster : sert au garde-fou "image locale non déployable
    // sur multi-nœuds". Compté une fois pour ce déploiement.
    const nodeCount = (await docker.listNodes()).length

    for (const action of plan.actions) {
      if (action.kind === "remove") {
        await docker.removeService(action.dockerId)
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
      const labels = labelsFor(input, node)

      // 1) Disponibilité de l'image SELON LA POLICY (avant toute création de service).
      const image = `${cfg.image}:${cfg.tag}`
      const policy = effectivePullPolicy(cfg)
      let pulled: boolean
      try {
        ;({ pulled } = await docker.ensureImage(image, policy))
      } catch (err) {
        if (err instanceof ImageUnavailableError) throw new DeployError(err.message)
        throw err
      }

      // 2) Garde multi-nœuds : une image servie depuis le local (pas pull) n'est pas
      //    déployable de façon fiable sur un cluster (un autre nœud ne l'a pas).
      if (!pulled && nodeCount > 1) {
        throw new DeployError(
          `Image locale « ${image} » (policy ${policy}) non déployable sur un cluster ` +
            `multi-nœuds (${nodeCount} nœuds) : pousse-la sur un registre (ex. ghcr.io/...) ` +
            `et référence-la par ce nom, ou enregistre ses identifiants dans Registres.`
        )
      }

      try {
        if (action.kind === "update") {
          // ROLLING UPDATE zero-downtime (start-first) — pas de remove+create.
          await docker.updateService(action.existingId, name, cfg, labels, networks, mounts)
          s.deployed.set(node.id, { dockerId: action.existingId, actualState: "running" })
          s.log.push(`service ${node.name} mis à jour (rolling, ${cfg.replicas} replicas)`)
        } else {
          const svc = await docker.createService(name, cfg, labels, networks, mounts)
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
      await docker.removeService(id).catch(() => {})
    }
  },
}

const gatewaysStep: Step<DeployInput> = {
  name: "gateways",
  run: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    const slug = input.graph.slug
    for (const node of input.graph.nodes.filter((n) => n.type === "gateway")) {
      const cfg = parseNodeConfig("gateway", node.config) as GatewayConfig
      // La cible = le conteneur lié par un edge "gateway" (ou le 1er conteneur lié).
      const target = input.graph.edges
        .filter((e) => e.sourceNodeId === node.id || e.targetNodeId === node.id)
        .map((e) => {
          const otherId = e.sourceNodeId === node.id ? e.targetNodeId : e.sourceNodeId
          return input.graph.nodes.find((n) => n.id === otherId && n.type === "container")
        })
        .find(Boolean)
      if (!target) {
        s.log.push(`passerelle ${node.name} ignorée (aucun conteneur lié)`)
        continue
      }
      const upstreamHost = resourceName(slug, target.name)
      await exposureService.upsertRoute(slug, node.name, cfg, upstreamHost)
      s.createdGateways.push({ nodeName: node.name })
      // Une passerelle = une route Caddy : "up" dès qu'elle existe (pas de cycle de
      // vie observable par events Docker comme un conteneur). On la marque running.
      s.deployed.set(node.id, { actualState: "running" })
      s.log.push(`passerelle ${cfg.domain} -> ${target.name}:${cfg.targetPort}`)
    }
  },
  compensate: async (input, ctx) => {
    const s = ctx.shared as DeployShared
    for (const g of s.createdGateways.reverse()) {
      await exposureService.deleteRoute(input.graph.slug, g.nodeName).catch(() => {})
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
  const shared: DeployShared = {
    log: [],
    networkIdByNodeId: new Map(),
    createdServiceIds: [],
    createdNetworkIds: [],
    createdGateways: [],
    deployed: new Map(),
  }
  const result = await runWorkflow<DeployInput>(
    "deploy-project",
    [networksStep, volumesStep, servicesStep, gatewaysStep],
    input,
    {},
    shared as unknown as Record<string, unknown>
  )
  if (!result.ok) {
    // Préserve le type d'erreur d'origine (DeployError → 422 côté route) ;
    // pour les autres, message brut prefixé (vrai bug → 500).
    if (result.errorCause instanceof DeployError) throw result.errorCause
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

  return final.log
}
