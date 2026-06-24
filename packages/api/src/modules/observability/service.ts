import { LabelKeys } from "@bozando-ops/shared"
import { DockerEngineService } from "../docker-engine/service"
import type { ServiceMetrics } from "../docker-engine/service"
import { eventBus } from "../../lib/event-bus"

/**
 * Observability — agrège l'état NATIF de Swarm pour le rendre visible (HealthPage)
 * et suit le drift détecté par le job (badge canvas + bouton réconcilier).
 *
 * Tout est LECTURE SEULE ici : aucune action correctrice. Le self-healing est
 * natif Swarm (RestartPolicy=any) ; on ne fait que l'observer.
 */

export type NodeHealth = {
  swarmNodeId: string
  hostname: string
  role: string
  state: string // ready | down | unknown
  availability: string // active | pause | drain
  leader: boolean
}

/** Placement d'une task d'un service, enrichi du hostname du nœud (lisible). */
export type ServicePlacement = {
  nodeId: string
  hostname: string
  state: string
  desiredState: string
  error?: string
}

export type ServiceHealth = ServiceMetrics & {
  projectId?: string
  nodeId?: string
  /** Sur quels nœuds tournent les tasks de ce service (+ leur état). */
  placements: ServicePlacement[]
}

/** Agrégat par projet : sur quels serveurs (hostnames) ce projet tourne. */
export type ProjectPlacement = {
  projectId: string
  servers: string[]
}

export type ClusterHealth = {
  swarmActive: boolean
  nodes: NodeHealth[]
  services: ServiceHealth[]
}

/** Projet -> nombre d'actions de drift en attente (alimenté par le job de drift). */
const driftByProject = new Map<string, { count: number; actions: string[]; at: number }>()

export class ObservabilityService {
  private engine: DockerEngineService
  constructor(engine = new DockerEngineService()) {
    this.engine = engine
  }

  /** Vue agrégée du cluster : nœuds Swarm + métriques par service géré. */
  async clusterHealth(): Promise<ClusterHealth> {
    const swarmActive = await this.engine.isSwarmActive()
    if (!swarmActive) return { swarmActive: false, nodes: [], services: [] }

    const [rawNodes, services] = await Promise.all([
      this.engine.listNodes(),
      this.engine.listManagedServices(),
    ])

    const nodes: NodeHealth[] = (rawNodes as RawNode[]).map((n) => ({
      swarmNodeId: n.ID ?? "",
      hostname: n.Description?.Hostname ?? n.ID ?? "?",
      role: n.Spec?.Role ?? "worker",
      state: n.Status?.State ?? "unknown",
      availability: n.Spec?.Availability ?? "active",
      leader: Boolean(n.ManagerStatus?.Leader),
    }))

    // nodeId -> hostname pour rendre les placements lisibles.
    const hostnameById = new Map(nodes.map((n) => [n.swarmNodeId, n.hostname]))

    const metrics = await Promise.all(
      (services as RawService[]).map(async (svc) => {
        const id = svc.ID ?? ""
        const labels = svc.Spec?.Labels ?? {}
        const [m, rawPlacements] = await Promise.all([
          this.engine.getServiceMetrics(id),
          this.engine.listServiceTaskPlacements(id),
        ])
        const placements: ServicePlacement[] = rawPlacements.map((p) => ({
          nodeId: p.nodeId,
          hostname: hostnameById.get(p.nodeId) ?? p.nodeId ?? "?",
          state: p.state,
          desiredState: p.desiredState,
          error: p.error,
        }))
        return {
          ...m,
          projectId: labels[LabelKeys.projectId],
          nodeId: labels[LabelKeys.nodeId],
          placements,
        } as ServiceHealth
      })
    )

    return { swarmActive: true, nodes, services: metrics }
  }

  /**
   * Santé COMPLÈTE d'un seul service (métriques + placement par task), pour le
   * drill-down de la page Santé. Renvoie le MÊME type `ServiceHealth` que la liste
   * (`placements` TOUJOURS présent) — sans ça, le front qui lit `s.placements`
   * planterait dès que la réponse du /metrics remplace l'objet de la liste.
   */
  async serviceHealth(serviceId: string): Promise<ServiceHealth> {
    const [m, rawPlacements, rawNodes] = await Promise.all([
      this.engine.getServiceMetrics(serviceId),
      this.engine.listServiceTaskPlacements(serviceId),
      this.engine.listNodes(),
    ])
    const hostnameById = new Map(
      (rawNodes as RawNode[]).map((n) => [n.ID ?? "", n.Description?.Hostname ?? n.ID ?? "?"])
    )
    const placements: ServicePlacement[] = rawPlacements.map((p) => ({
      nodeId: p.nodeId,
      hostname: hostnameById.get(p.nodeId) ?? p.nodeId ?? "?",
      state: p.state,
      desiredState: p.desiredState,
      error: p.error,
    }))
    return { ...m, placements }
  }

  /**
   * Agrège, par projet, la liste DISTINCTE des serveurs (hostnames) où des tasks
   * tournent réellement. Répond à "quel serveur ce projet touche-t-il ?".
   * Si un projectId est fourni, ne renvoie que ce projet.
   */
  async projectPlacements(projectId?: string): Promise<ProjectPlacement[]> {
    const health = await this.clusterHealth()
    const byProject = new Map<string, Set<string>>()
    for (const svc of health.services) {
      if (!svc.projectId) continue
      if (projectId && svc.projectId !== projectId) continue
      const set = byProject.get(svc.projectId) ?? new Set<string>()
      for (const p of svc.placements) {
        // Ne compte que les tasks effectivement actives sur un nœud.
        if (p.state === "running" || p.desiredState === "running") set.add(p.hostname)
      }
      byProject.set(svc.projectId, set)
    }
    return Array.from(byProject.entries()).map(([pid, servers]) => ({
      projectId: pid,
      servers: Array.from(servers).sort(),
    }))
  }

  // ── Drift (mémoire vive, alimentée par le job reconcile-drift) ───────────────

  recordDrift(projectId: string, count: number, actions: string[]): void {
    if (count <= 0) driftByProject.delete(projectId)
    else driftByProject.set(projectId, { count, actions, at: Date.now() })
  }

  clearDrift(projectId: string): void {
    driftByProject.delete(projectId)
  }

  /** État de drift courant (pour le badge canvas + page santé). */
  driftSnapshot(): { projectId: string; count: number; actions: string[]; at: number }[] {
    return Array.from(driftByProject.entries()).map(([projectId, v]) => ({
      projectId,
      ...v,
    }))
  }
}

export const observabilityService = new ObservabilityService()

/**
 * Branche l'écoute du drift : à chaque "drift.detected" émis par le job, on
 * mémorise l'état pour le badge ; à chaque déploiement réussi, on le nettoie.
 */
export function registerObservabilitySubscribers(): void {
  eventBus.on("drift.detected", (evt) => {
    const d = evt.data as { projectId: string; count: number; actions: string[] }
    observabilityService.recordDrift(d.projectId, d.count, d.actions ?? [])
  })
  eventBus.on("deploy.finished", (evt) => {
    const d = evt.data as { projectId: string; ok?: boolean }
    if (d.ok) observabilityService.clearDrift(d.projectId)
  })
  eventBus.on("destroy.finished", (evt) => {
    const d = evt.data as { projectId: string }
    observabilityService.clearDrift(d.projectId)
  })
}

// ── Types partiels des payloads dockerode (typés `any` côté lib) ──────────────

type RawNode = {
  ID?: string
  Description?: { Hostname?: string }
  Spec?: { Role?: string; Availability?: string }
  Status?: { State?: string }
  ManagerStatus?: { Leader?: boolean }
}

type RawService = {
  ID?: string
  Spec?: { Labels?: Record<string, string> }
}
