import { Label } from '@medusajs/ui';
import { LabelKeys } from "@hullbay/shared"
import { prisma } from "../lib/prisma"
import { DockerEngineService } from "../modules/docker-engine/service"
import { eventBus } from "../lib/event-bus"
import { runWithConcurrency, CLUSTER_CONCURRENCY } from "../lib/concurrency"

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
  clusterId: string
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
  const known = await knownProjectIds();
  const clusters = await prisma.cluster.findMany({ select: { id: true } });

  const { items, totalMs } = await runWithConcurrency(
    clusters.map((c) => c.id),
    CLUSTER_CONCURRENCY,
    async (clusterId) => {
      const engine = await DockerEngineService.forCluster(clusterId);
      const [services, networks, volumes] = await Promise.all([
        engine.listManagedServices(),
        engine.listManagedNetworks(),
        engine.listManagedVolumes(),
      ]);
      return { clusterId, engine, services, networks, volumes };
    },
  );

  const candidates: PruneCandidate[] = [];
  const removed: PruneCandidate[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const it of items) {
    if (it.status === "rejected") {
      const clusterId = clusters[it.index]!.id;
      errors.push({
        id: clusterId,
        error: `cluster injoignable : ${it.reason instanceof Error ? it.reason.message : String(it.reason)}`,
      });
      continue;
    }
    const { clusterId, engine, services, networks, volumes } = it.value;

    const consider = (
      kind: PruneCandidate["kind"],
      id: string,
      name: string,
      labels: Record<string, string>,
    ) => {
      if (labels[LabelKeys.system] === "true") return;
      if (labels[LabelKeys.managed] !== "true") return;
      const projectId = labels[LabelKeys.projectId];
      if (!projectId)
        candidates.push({ kind, id, name, clusterId, reason: "sans projectId" });
      else if (!known.has(projectId))
        candidates.push({ kind, id, name, clusterId, projectId, reason: "projet inexistant" });
    };

    for (const s of services as RawNamed[])
      consider("service", s.ID ?? "", s.Spec?.Name ?? s.ID ?? "?", labelsOf(s));
    for (const n of networks as RawNamed[])
      consider("network", n.Id ?? "", n.Name ?? n.Id ?? "?", labelsOf(n));
    for (const v of volumes as RawNamed[])
      consider("volume", v.Name ?? "", v.Name ?? "?", labelsOf(v));

    if (apply) {
      const order = { service: 0, network: 1, volume: 2 } as const;
      const clusterCandidates = candidates.filter((cand) => cand.clusterId === clusterId);
      for (const cand of [...clusterCandidates].sort(
        (a, b) => order[a.kind] - order[b.kind],
      )) {
        try {
          if (cand.kind === "service") await engine.removeService(cand.id);
          else if (cand.kind === "network") await engine.removeNetwork(cand.id);
          else await engine.removeVolume(cand.name);
          removed.push(cand);
        } catch (err) {
          errors.push({
            id: cand.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  console.log(`[prune] ${clusters.length} clusters en ${totalMs.toFixed(0)}ms (concurrency=${CLUSTER_CONCURRENCY}, apply=${apply})`);

  if (apply) {
    await eventBus.emit("prune.finished", {
      removed: removed.length,
      errors: errors.length,
    });
  }

  return { applied: apply, candidates, removed, errors };
}

type RawNamed = {
  ID?: string
  Id?: string
  Name?: string
  Spec?: { Name?: string; Labels?: Record<string, string> }
  Labels?: Record<string, string>
}
