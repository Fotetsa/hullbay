import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Badge,
  Button,
  Container,
  Drawer,
  Heading,
  StatusBadge,
  Table,
  Text,
  toast,
} from "@medusajs/ui"
import { ArrowPath, Bolt, ChartBar, Trash } from "@medusajs/icons"
import { api, type ServiceHealth, type ServicePlacement, type PruneCandidate } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"

/**
 * Page Santé — rend visible l'état NATIF de Swarm (nœuds + métriques par service)
 * et le drift détecté. Lecture seule sauf le prune (owner, destructif, confirmé).
 * Auto-rafraîchie (les métriques sont des échantillons instantanés).
 */
export function HealthPage() {
  const qc = useQueryClient()
  const { data: health, isLoading } = useQuery({
    queryKey: ["health"],
    queryFn: api.clusterHealth,
    refetchInterval: 10_000,
  })
  const { data: drift } = useQuery({
    queryKey: ["drift"],
    queryFn: api.drift,
    refetchInterval: 15_000,
  })

  const [detailService, setDetailService] = useState<ServiceHealth | null>(null)
  const [candidates, setCandidates] = useState<PruneCandidate[]>([])
  const preview = useMutationToast({
    mutationFn: api.prunePreview,
    onSuccess: (r) => {
      if (r.candidates.length === 0) toast.success("Aucune ressource orpheline")
      setCandidates(r.candidates)
    },
  })
  const apply = useMutationToast({
    mutationFn: api.pruneApply,
    success: (r) => `Prune : ${r.removed.length} supprimées, ${r.errors.length} erreurs`,
    invalidate: [["health"]],
    onSuccess: () => setCandidates([]),
  })

  return (
    <PageContainer size="5xl">
      <PageHeader
        title="Santé du cluster"
        actions={
          <Button
            variant="secondary"
            size="small"
            onClick={() => qc.invalidateQueries({ queryKey: ["health"] })}
          >
            <ArrowPath /> Rafraîchir
          </Button>
        }
      />

      {isLoading ? (
        <Text>Chargement…</Text>
      ) : !health?.swarmActive ? (
        <Container className="p-6">
          <Text className="text-ui-fg-subtle">
            Swarm inactif. Lance `docker swarm init` sur le manager pour activer
            services, replicas et observabilité.
          </Text>
        </Container>
      ) : (
        <div className="flex flex-col gap-6">
          {/* Drift */}
          {drift && drift.drift.length > 0 && (
            <Container className="border-ui-border-error p-4">
              <Heading level="h3" className="mb-2 text-ui-fg-error">
                Drift détecté
              </Heading>
              <Text size="small" className="text-ui-fg-subtle">
                {drift.drift.length} projet(s) divergent du désiré. Redéploie le
                projet concerné pour réconcilier.
              </Text>
              <div className="mt-2 flex flex-wrap gap-2">
                {drift.drift.map((d) => (
                  <Badge key={d.projectId} color="red" size="2xsmall">
                    {d.projectId.slice(0, 8)} · {d.count} action(s)
                  </Badge>
                ))}
              </div>
            </Container>
          )}

          {/* Nœuds Swarm */}
          <Container className="p-4">
            <Heading level="h3" className="mb-3 flex items-center gap-2">
              Nœuds ({health.nodes.length})
            </Heading>
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Hôte</Table.HeaderCell>
                    <Table.HeaderCell>Rôle</Table.HeaderCell>
                    <Table.HeaderCell>État</Table.HeaderCell>
                    <Table.HeaderCell>Dispo.</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {health.nodes.map((n) => (
                    <Table.Row key={n.swarmNodeId}>
                      <Table.Cell>
                        {n.hostname}
                        {n.leader && (
                          <Badge size="2xsmall" className="ml-2" color="blue">
                            leader
                          </Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell>{n.role}</Table.Cell>
                      <Table.Cell>
                        <StatusBadge color={n.state === "ready" ? "green" : "red"}>
                          {n.state}
                        </StatusBadge>
                      </Table.Cell>
                      <Table.Cell>{n.availability}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          </Container>

          {/* Services */}
          <Container className="p-4">
            <Heading level="h3" className="mb-3 flex items-center gap-2">
              <ChartBar /> Services ({health.services.length})
            </Heading>
            <div className="overflow-x-auto">
              <Table>
                <Table.Header>
                  <Table.Row>
                    <Table.HeaderCell>Service</Table.HeaderCell>
                    <Table.HeaderCell>Replicas</Table.HeaderCell>
                    <Table.HeaderCell>Nœuds</Table.HeaderCell>
                    <Table.HeaderCell>CPU moy.</Table.HeaderCell>
                    <Table.HeaderCell>Mémoire</Table.HeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {health.services.map((s) => (
                    <ServiceRow key={s.serviceId} s={s} onSelect={() => setDetailService(s)} />
                  ))}
                </Table.Body>
              </Table>
            </div>
            {health.services.length === 0 && (
              <Text className="mt-2 text-ui-fg-subtle">Aucun service géré.</Text>
            )}
          </Container>

          {/* Prune orphelins */}
          <Container className="p-4">
            <Heading level="h3" className="mb-2">
              Ressources orphelines
            </Heading>
            <Text size="small" className="text-ui-fg-subtle">
              Ressources gérées (bozando.managed) dont le projet n'existe plus.
              Le système (bozando.system) n'est jamais touché.
            </Text>
            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                size="small"
                onClick={() => preview.mutate()}
                isLoading={preview.isPending}
              >
                Analyser
              </Button>
              {candidates.length > 0 && (
                <Button
                  variant="danger"
                  size="small"
                  onClick={() => apply.mutate()}
                  isLoading={apply.isPending}
                >
                  <Trash /> Supprimer {candidates.length} orpheline(s)
                </Button>
              )}
            </div>
            {candidates.length > 0 && (
              <div className="mt-3 flex flex-col gap-1">
                {candidates.map((c, i) => (
                  <Text key={i} size="small" className="text-ui-fg-muted">
                    {c.kind} · {c.name} — {c.reason}
                  </Text>
                ))}
              </div>
            )}
          </Container>
        </div>
      )}

      <ServiceDetailDrawer
        service={detailService}
        onClose={() => setDetailService(null)}
      />
    </PageContainer>
  )
}

/**
 * Détail d'un service au clic : rafraîchit les métriques fines via
 * GET /api/services/:id/metrics et liste le placement par task (nœud + état).
 */
function ServiceDetailDrawer({
  service,
  onClose,
}: {
  service: ServiceHealth | null
  onClose: () => void
}) {
  const { data } = useQuery({
    queryKey: ["service-metrics", service?.serviceId],
    queryFn: () => api.serviceMetrics(service!.serviceId),
    enabled: !!service,
    refetchInterval: 8_000,
  })
  const s = data ?? service
  // `placements` doit TOUJOURS être un tableau pour le rendu (.length/.map/.some) :
  // filet défensif si une réponse partielle/erreur l'omet (sinon crash ErrorBoundary).
  const placements = s?.placements ?? []
  const memMb = s?.totalMemBytes ? Math.round(s.totalMemBytes / (1024 * 1024)) : 0

  return (
    <Drawer open={!!service} onOpenChange={(o) => !o && onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{s?.name ?? "Service"}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-4 overflow-y-auto">
          {!s ? (
            <Text className="text-ui-fg-subtle">Chargement…</Text>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Replicas" value={`${s.runningReplicas}/${s.desiredReplicas}`} />
                <Metric label="Tasks échantillonnées" value={String(s.sampledTasks)} />
                <Metric label="CPU moyen" value={s.sampledTasks ? `${s.avgCpuPct}%` : "n/d"} />
                <Metric label="Mémoire" value={memMb ? `${memMb} Mo` : "—"} />
              </div>

              <div>
                <Heading level="h3" className="mb-2">
                  Placement des tasks
                </Heading>
                {placements.length === 0 ? (
                  <Text size="small" className="text-ui-fg-subtle">
                    Aucune task en cours.
                  </Text>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <Table.Header>
                        <Table.Row>
                          <Table.HeaderCell>Nœud</Table.HeaderCell>
                          <Table.HeaderCell>État</Table.HeaderCell>
                          <Table.HeaderCell>Désiré</Table.HeaderCell>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {placements.map((p, i) => {
                          const fail = ["failed", "rejected", "shutdown"].includes(p.state)
                          return (
                            <Table.Row key={i}>
                              <Table.Cell>{p.hostname}</Table.Cell>
                              <Table.Cell>
                                <StatusBadge color={fail ? "red" : p.state === "running" ? "green" : "orange"}>
                                  {p.state}
                                </StatusBadge>
                              </Table.Cell>
                              <Table.Cell>{p.desiredState}</Table.Cell>
                            </Table.Row>
                          )
                        })}
                      </Table.Body>
                    </Table>
                  </div>
                )}
                {placements.some((p) => p.error) && (
                  <div className="mt-3 flex flex-col gap-1">
                    {placements
                      .filter((p) => p.error)
                      .map((p, i) => (
                        <Text key={i} size="xsmall" className="text-ui-fg-error">
                          {p.hostname} : {p.error}
                        </Text>
                      ))}
                  </div>
                )}
              </div>
            </>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ui-border-base p-3">
      <Text size="xsmall" className="text-ui-fg-muted">
        {label}
      </Text>
      <Text weight="plus">{value}</Text>
    </div>
  )
}

function ServiceRow({ s, onSelect }: { s: ServiceHealth; onSelect: () => void }) {
  const healthy = s.runningReplicas >= s.desiredReplicas && s.desiredReplicas > 0
  const memMb = s.totalMemBytes ? Math.round(s.totalMemBytes / (1024 * 1024)) : 0
  return (
    <Table.Row className="cursor-pointer" onClick={onSelect}>
      <Table.Cell>{s.name}</Table.Cell>
      <Table.Cell>
        <StatusBadge color={healthy ? "green" : "orange"}>
          {s.runningReplicas}/{s.desiredReplicas}
        </StatusBadge>
      </Table.Cell>
      <Table.Cell>
        <PlacementCell placements={s.placements} />
      </Table.Cell>
      <Table.Cell>
        {s.sampledTasks > 0 ? (
          <span className="flex items-center gap-1">
            {s.avgCpuPct >= 75 && <Bolt className="text-ui-fg-error" />}
            {s.avgCpuPct}%
          </span>
        ) : (
          <Text size="small" className="text-ui-fg-muted">
            n/d
          </Text>
        )}
      </Table.Cell>
      <Table.Cell>{memMb ? `${memMb} Mo` : "—"}</Table.Cell>
    </Table.Row>
  )
}

/**
 * Affiche sur quels nœuds tournent les tasks d'un service : un badge par nœud,
 * coloré selon l'état (vert = running, orange = en transition, rouge = échec).
 * Plusieurs tasks sur le même nœud sont regroupées (xN).
 */
function PlacementCell({ placements }: { placements: ServicePlacement[] }) {
  if (!placements.length) {
    return (
      <Text size="small" className="text-ui-fg-muted">
        —
      </Text>
    )
  }
  // Regroupe par hostname en gardant le "pire" état (échec > transition > running).
  const rank: Record<string, number> = { running: 0 }
  const byHost = new Map<string, { count: number; worst: string }>()
  for (const p of placements) {
    const cur = byHost.get(p.hostname)
    const isFail = ["failed", "rejected", "shutdown"].includes(p.state)
    const state = isFail ? p.state : p.state === "running" ? "running" : "transition"
    if (!cur) {
      byHost.set(p.hostname, { count: 1, worst: state })
    } else {
      cur.count += 1
      if ((rank[state] ?? 1) > (rank[cur.worst] ?? 1)) cur.worst = state
    }
  }
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from(byHost.entries()).map(([host, { count, worst }]) => (
        <Badge
          key={host}
          size="2xsmall"
          color={worst === "running" ? "green" : worst === "transition" ? "orange" : "red"}
        >
          {host}
          {count > 1 ? ` ×${count}` : ""}
        </Badge>
      ))}
    </div>
  )
}
