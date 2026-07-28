import { LabelKeys } from "@hullbay/shared"
import { prisma } from "../lib/prisma"
import { DockerEngineService } from "../modules/docker-engine/service"
import { eventBus } from "../lib/event-bus"

/**
 * Job prune-orphans — supprime les ressources Docker GÉRÉES (bozando.managed=true)
 * qui n'appartiennent plus à aucun projet connu en base (orphelines après un
 * destroy partiel, un rebuild divergent, etc.).
 *
 * GARDE-FOUS STRICTS :
 *  - Ne touche JAMAIS `bozando.system=true` (l'ops-panel lui-même).
 *  - Ne supprime que les ressources dont le `bozando.projectId` n'existe plus en base.
 *  - DRY-RUN par défaut : liste ce qui serait supprimé sans agir, sauf `apply=true`.
 *    (Suppression destructive : on ne l'exécute que sur action explicite owner.)
 */

export type PruneCandidate = {
  kind: "service" | "network" | "volume"
  id: string
  name: string
  projectId?: string
  reason: string
}

export type PruneResult = {
  applied: boolean
  candidates: PruneCandidate[]
  removed: PruneCandidate[]
  errors: { id: string; error: string }[]
}

function labelsOf(r: { Spec?: { Labels?: Record<string, string> }; Labels?: Record<string, string> }) {
  return r.Spec?.Labels ?? r.Labels ?? {}
}

/** Un projet est "connu" si son id figure dans la table Project. */
async function knownProjectIds(): Promise<Set<string>> {
  const rows = await prisma.project.findMany({ select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

export async function pruneOrphans(apply = false): Promise<PruneResult> {
  const engine = new DockerEngineService()
  const known = await knownProjectIds()

  const [services, networks, volumes] = await Promise.all([
    engine.listManagedServices(),
    engine.listManagedNetworks(),
    engine.listManagedVolumes(),
  ])

  const candidates: PruneCandidate[] = []

  const consider = (
    kind: PruneCandidate["kind"],
    id: string,
    name: string,
    labels: Record<string, string>
  ) => {
    // GARDE-FOU ABSOLU : on ne touche jamais le système.
    if (labels[LabelKeys.system] === "true") return
    if (labels[LabelKeys.managed] !== "true") return
    const projectId = labels[LabelKeys.projectId]
    // Orphelin = pas de projectId, ou projectId inconnu en base.
    if (!projectId) {
      candidates.push({ kind, id, name, reason: "sans projectId" })
    } else if (!known.has(projectId)) {
      candidates.push({ kind, id, name, projectId, reason: "projet inexistant" })
    }
  }

  for (const s of services as RawNamed[]) {
    consider("service", s.ID ?? "", s.Spec?.Name ?? s.ID ?? "?", labelsOf(s))
  }
  for (const n of networks as RawNamed[]) {
    consider("network", n.Id ?? "", n.Name ?? n.Id ?? "?", labelsOf(n))
  }
  for (const v of volumes as RawNamed[]) {
    consider("volume", v.Name ?? "", v.Name ?? "?", labelsOf(v))
  }

  const removed: PruneCandidate[] = []
  const errors: { id: string; error: string }[] = []

  if (apply) {
    // Ordre : services d'abord (libère réseaux/volumes), puis réseaux, puis volumes.
    const order = { service: 0, network: 1, volume: 2 } as const
    for (const c of [...candidates].sort((a, b) => order[a.kind] - order[b.kind])) {
      try {
        if (c.kind === "service") await engine.removeService(c.id)
        else if (c.kind === "network") await engine.removeNetwork(c.id)
        else await engine.removeVolume(c.name)
        removed.push(c)
      } catch (err) {
        errors.push({ id: c.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    await eventBus.emit("prune.finished", {
      removed: removed.length,
      errors: errors.length,
    })
  }

  return { applied: apply, candidates, removed, errors }
}

type RawNamed = {
  ID?: string
  Id?: string
  Name?: string
  Spec?: { Name?: string; Labels?: Record<string, string> }
  Labels?: Record<string, string>
}
