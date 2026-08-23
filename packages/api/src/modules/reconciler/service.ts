import { computeDesiredHash, LabelKeys, isRetainedDataVolume, type NodeType } from "@hullbay/shared"
import { DockerEngineService } from "../docker-engine/service"
import { exposureService } from "../exposure/service"
import type { ProjectGraph, Node } from "@hullbay/shared"

/**
 * Reconciler : fait converger le RÉEL (Swarm) vers le DÉSIRÉ (le graphe du projet).
 *
 * Modèle desired-vs-actual + diff IDEMPOTENT (services Swarm) :
 *   - nœud absent de Swarm             -> créer le service
 *   - présent, desiredHash identique   -> no-op
 *   - présent, desiredHash différent   -> UPDATE (rolling, zero-downtime)
 *   - service géré absent du graphe     -> supprimer
 *
 * Ordre de déploiement : networks(overlay) -> volumes -> services -> gateways.
 * Les labels bozando.* portent le MAX d'infos (spec/edges/canvas) pour rebuild.
 */

export type DiffAction =
  | { kind: "create"; node: Node }
  | { kind: "update"; node: Node; existingId: string }
  | { kind: "noop"; node: Node; existingId: string }
  | { kind: "remove"; dockerId: string; name: string; type: NodeType }

export interface ReconcilePlan {
  actions: DiffAction[]
}

export class ReconcilerService {
  constructor(private docker : DockerEngineService) {}

  /**
   * Calcule le plan de réconciliation en comparant le graphe désiré aux SERVICES
   * Swarm réels labellisés du projet.
   */
  async plan(graph: ProjectGraph): Promise<ReconcilePlan> {
    const existing = await this.docker.listProjectServices(graph.id)
    const byNodeId = new Map<string, { id: string; hash: string | undefined }>()
    for (const s of existing) {
      const labels = s.Spec?.Labels ?? {}
      const nodeId = labels[LabelKeys.nodeId]
      if (nodeId) {
        byNodeId.set(nodeId, { id: s.ID, hash: labels[LabelKeys.desiredHash] })
      }
    }

    const actions: DiffAction[] = []
    const desiredNodeIds = new Set<string>()

    for (const node of graph.nodes) {
      desiredNodeIds.add(node.id)
      if (node.type !== "container") continue
      const found = byNodeId.get(node.id)
      const desiredHash = computeDesiredHash({
        type: node.type,
        name: node.name,
        config: node.config,
      })
      if (!found) {
        actions.push({ kind: "create", node })
      } else if (found.hash !== desiredHash) {
        actions.push({ kind: "update", node, existingId: found.id })
      } else {
        actions.push({ kind: "noop", node, existingId: found.id })
      }
    }

    // Services réels qui ne sont plus dans le graphe -> remove.
    for (const s of existing) {
      const nodeId = s.Spec?.Labels?.[LabelKeys.nodeId]
      if (!nodeId || !desiredNodeIds.has(nodeId)) {
        actions.push({
          kind: "remove",
          dockerId: s.ID,
          name: s.Spec?.Name ?? s.ID,
          type: "container",
        })
      }
    }

    return { actions }
  }

  /**
   * Détruit toutes les ressources gérées d'un projet
   * (routes Caddy -> services -> secrets -> volumes -> networks).
   *
   * RÉTENTION des volumes de données : 3 cases, dans l'ordre :
   *  1. DANS le graphe et retain=true  (retainedVolumeNames)  → conservé.
   *  2. DANS le graphe et retain=false (managedDataVolumeNames) → supprimé :
   *     la config live (persistée) prime sur un label daté d'un ancien deploy —
   *     Docker ne met pas à jour les labels d'un volume existant.
   *  3. HORS du graphe (orphelin) → garde par label bozando.database.data :
   *     plus rien dans le graphe ne peut exprimer une politique, on ne détruit
   *     pas aveuglément des données.
   */
  async destroy(
    graph: ProjectGraph,
    {
      retainedVolumeNames = new Set<string>(),
      managedDataVolumeNames = new Set<string>(),
    }: {
      retainedVolumeNames?: Set<string>
      managedDataVolumeNames?: Set<string>
    } = {}
  ): Promise<string[]> {
    const log: string[] = []

    // 0. Routes Caddy des passerelles.
    for (const node of graph.nodes.filter((n) => n.type === "gateway")) {
      await exposureService.deleteRoute(graph.clusterId, graph.slug, node.name).catch(() => {})
      log.push(`route passerelle ${node.name} supprimée`)
    }

    const services = await this.docker.listProjectServices(graph.id)
    for (const s of services) {
      await this.docker.removeService(s.ID)
      // `removeService` se résout dès que Docker ACCEPTE la suppression, pas quand
      // les tasks/conteneurs ont fini de s'arrêter et de démonter leurs volumes —
      // c'est asynchrone côté scheduler Swarm. Sans cette attente, le removeVolume
      // qui suit arrive trop tôt et échoue en 409 "volume is in use - [containerId]"
      // (observé en prod).
      await this.waitServiceTasksGone(s.ID)
      log.push(`service ${s.Spec?.Name ?? s.ID} supprimé`)
    }
    // Secrets de config GÉNÉRÉS par l'expansion (patroni-replication, haproxy.cfg…)
    // : purge best-effort. Immutables et versionnés par contenu, ils s'accumulent
    // sinon à chaque cycle deploy/destroy. Un secret encore référencé (rare, tasks
    // en cours) est toléré — réessai au prochain destroy/déploiement.
    const secrets = await this.docker.listManagedSecrets()
    for (const sec of secrets) {
      const labels = sec.labels ?? {}
      const mine =
        labels["bozando.database.generated"] === "true" &&
        labels[LabelKeys.projectId] === graph.id
      if (!mine) continue
      try {
        await this.docker.removeSecret(sec.name)
        log.push(`secret généré ${sec.name} supprimé`)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        log.push(`secret généré ${sec.name} retenu (encore référencé ?) : ${detail}`)
      }
    }
    const networks = await this.docker.listManagedNetworks()
    for (const n of networks.filter((n) => n.Labels?.[LabelKeys.projectId] === graph.id)) {
      await this.docker.removeNetwork(n.Id)
      log.push(`network ${n.Name} supprimé`)
    }
    const volumes = await this.docker.listManagedVolumes()
    for (const v of volumes.filter((v) => v.Labels?.[LabelKeys.projectId] === graph.id)) {
      // RÉTENTION  — cf. doc de destroy : décision LIVE (graphe) d'abord,
      // garde par label pour les seuls volumes orphelins de toute décision.
      if (retainedVolumeNames.has(v.Name)) {
        log.push(`volume ${v.Name} conservé (rétention définie dans la config)`)
        continue
      }
      if (managedDataVolumeNames.has(v.Name)) {
        log.push(`volume ${v.Name} supprimé (rétention désactivée dans la config)`)
        await this.removeVolumeWithRetry(v.Name)
        continue
      }
      if (isRetainedDataVolume(v.Labels)) {
        log.push(`volume ${v.Name} conservé (données retenues)`)
        continue
      }
      // Filet de sécurité en plus de `waitServiceTasksGone` : un volume peut rester
      // "in use" un instant même après disparition des tasks (démontage du device
      // côté nœud, légèrement décalé). Retry court avec backoff plutôt qu'échec sec.
      await this.removeVolumeWithRetry(v.Name)
      log.push(`volume ${v.Name} supprimé`)
    }
    return log
  }

  /** Attend que toutes les tasks d'un service supprimé aient disparu (poll, borné). */
  private async waitServiceTasksGone(
    serviceId: string,
    { attempts = 10, delayMs = 500 } = {}
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const tasks = await this.docker.listServiceTasks(serviceId).catch(() => [])
      if (tasks.length === 0) return
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  /** Retry avec backoff sur la suppression d'un volume (démontage asynchrone côté Swarm). */
  private async removeVolumeWithRetry(
    name: string,
    { attempts = 5, delayMs = 1_000 } = {}
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.docker.removeVolume(name)
        return
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (i === attempts - 1 || !msg.includes("volume is in use")) throw err
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
      }
    }
  }
}
