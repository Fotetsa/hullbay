import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Container, Heading, Text, Badge, Table } from "@medusajs/ui";
import {
  ArrowLeft,
  ServerStack,
  ArrowUpMini,
  ArrowDownMini,
  Trash,
  CircleMiniSolid,
} from "@medusajs/icons";
import { api, type Server, type ClusterHealth } from "../lib/api";
import { useMutationToast } from "../lib/useMutationToast";
import { useConfirmDelete } from "../lib/useConfirmDelete";
import { PageHeader, PageContainer } from "../components/PageHeader";
import { ActionMenu } from "../components/ActionMenu";

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
  ready: "green",
  provisioning: "orange",
  error: "grey",
  draining: "orange",
  down: "red",
};

const CLUSTER_STATUS_COLOR: Record<
  string,
  "green" | "orange" | "red" | "grey"
> = {
  ready: "green",
  pending: "orange",
  failed: "red",
};

type TabKey = "overview" | "services";

export function ClusterDetailPage() {
  const { clusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");


  const { data: clusters, isLoading: clustersLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.listClusters,
  });
  const { data: serversData, isLoading: serversLoading } = useQuery({
    queryKey: ["servers"],
    queryFn: api.listServers,
  });
  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: api.clusterHealth,
  });

  const isLoading = clustersLoading || serversLoading || healthLoading

  if (isLoading) {
    return (
      <PageContainer>
        <Text className="text-ui-fg-subtle">Chargement du cluster...</Text>
      </PageContainer>
    )
  }

  const cluster = clusters?.find((c) => c.id === clusterId)

  if (!cluster) {
    return (
      <PageContainer>
        <Container className="p-6 text-center">
          <Heading level="h2" className="mb-2">Cluster introuvable</Heading>
          <Text className="text-ui-fg-subtle mb-4">
            Ce cluster n'existe pas ou a été supprimé.
          </Text>
          <Button onClick={() => navigate("/servers")}>Retour aux serveurs</Button>
        </Container>
      </PageContainer>
    )
  }

  const servers = (serversData?.servers ?? []).filter((s) => s.clusterId === clusterId)
  const health = healthData?.clusters.find((c) => c.clusterId === clusterId)

  const setRole = useMutationToast({
    mutationFn: ({ id, role }: { id: string; role: "manager" | "worker" }) =>
      api.setServerRole(id, role),
    success: (r) => `Rôle changé : ${r.role}`,
    invalidate: [["servers"], ["health"]],
  });

  const removeServer = useConfirmDelete<Server>({
    mutationFn: (srv) => api.deleteServer(srv.id),
    success: "Serveur retiré",
    invalidate: [["servers"], ["health"]],
    confirm: (srv) => ({
      title: "Retirer ce serveur ?",
      description: `« ${srv.name} » (${srv.host}) sera drainé puis retiré du cluster Swarm. Les tasks qui y tournent seront reschedulées sur les autres nœuds. Action destructive.`,
    }),
  });

  const managersTotal = servers.filter((s) => s.role === "manager").length;
  const managersReachable =
    health?.nodes.filter((n) => n.role === "manager" && n.state === "ready")
      .length ?? 0;
  const quorumOk = managersTotal === 0 || managersReachable > managersTotal / 2;

  return (
    <PageContainer>
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="transparent"
          size="small"
          onClick={() => navigate("/servers")}
        >
          <ArrowLeft /> Retour
        </Button>
      </div>

      <PageHeader
        title={cluster?.name ?? "Cluster"}
        actions={
          cluster && (
            <Badge
              color={
                CLUSTER_STATUS_COLOR[cluster.isDefault ? "ready" : "ready"] ??
                "grey"
              }
              size="small"
            >
              {cluster.isDefault ? "cluster par défaut" : "cluster"}
            </Badge>
          )
        }
      />


      <div className="mb-4 flex gap-1 border-b border-ui-border-base">
        {(
          [
            ["overview", "Vue d'ensemble"],
            ["services", "Services"],
          ] as [TabKey, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-3 py-2 txt-compact-small-plus border-b-2 transition-colors ${
              tab === key
                ? "border-ui-fg-interactive text-ui-fg-interactive"
                : "border-transparent text-ui-fg-subtle hover:text-ui-fg-base"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          {managersTotal > 0 && (
            <Container className="flex items-center justify-between p-4">
              <div>
                <Heading level="h3">Quorum (HA control plane)</Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {managersReachable}/{managersTotal} managers joignables.
                  Recommandé : nombre impair (3 tolère 1 panne, 5 en tolère 2).
                </Text>
              </div>
              <Badge color={quorumOk ? "green" : "red"}>
                {quorumOk ? "quorum OK" : "quorum à risque"}
              </Badge>
            </Container>
          )}

          {!health?.swarmActive && (
            <Container className="p-4">
              <Text className="text-ui-fg-error">
                Ce cluster n'est pas joignable actuellement — aucune donnée de
                santé disponible.
              </Text>
            </Container>
          )}

          <div className="flex flex-col gap-3">
            {servers.map((srv) => {
              const nodeHealth = health?.nodes.find(
                (n) => n.swarmNodeId === srv.swarmNodeId,
              );
              return (
                <Container
                  key={srv.id}
                  className="flex items-center justify-between p-4"
                >
                  <div className="flex items-center gap-3">
                    <ServerStack />
                    <div>
                      <div className="flex items-center gap-2">
                        <Heading level="h3">{srv.name}</Heading>
                        <Badge size="2xsmall">{srv.role}</Badge>
                        <Badge
                          size="2xsmall"
                          color={STATUS_COLOR[srv.status] ?? "grey"}
                        >
                          {srv.status}
                        </Badge>
                        {nodeHealth?.leader && (
                          <Badge size="2xsmall" color="purple">
                            leader
                          </Badge>
                        )}
                      </div>
                      <Text size="small" className="text-ui-fg-subtle">
                        {srv.user}@{srv.host}:{srv.port}
                      </Text>
                      {srv.lastError && (
                        <Text size="xsmall" className="text-ui-fg-error">
                          {srv.lastError}
                        </Text>
                      )}
                    </div>
                  </div>
                  <ActionMenu
                    groups={[
                      {
                        actions: [
                          ...(srv.swarmNodeId && srv.role === "worker"
                            ? [
                                {
                                  label: "Promouvoir manager",
                                  icon: <ArrowUpMini />,
                                  onClick: () =>
                                    setRole.mutate({
                                      id: srv.id,
                                      role: "manager",
                                    }),
                                },
                              ]
                            : []),
                          ...(srv.swarmNodeId && srv.role === "manager"
                            ? [
                                {
                                  label: "Rétrograder worker",
                                  icon: <ArrowDownMini />,
                                  onClick: () =>
                                    setRole.mutate({
                                      id: srv.id,
                                      role: "worker",
                                    }),
                                },
                              ]
                            : []),
                        ],
                      },
                      {
                        actions: [
                          {
                            label: "Retirer du cluster",
                            icon: <Trash />,
                            variant: "danger" as const,
                            onClick: () => removeServer(srv),
                          },
                        ],
                      },
                    ]}
                  />
                </Container>
              );
            })}
            {servers.length === 0 && (
              <Text className="text-ui-fg-subtle">
                Aucun serveur dans ce cluster.
              </Text>
            )}
          </div>
        </div>
      )}

      {tab === "services" && (
        <Container className="p-0">
          {!health?.services.length ? (
            <Text className="p-6 text-ui-fg-subtle">
              Aucun service en cours sur ce cluster.
            </Text>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Service</Table.HeaderCell>
                  <Table.HeaderCell>Replicas</Table.HeaderCell>
                  <Table.HeaderCell>CPU moyen</Table.HeaderCell>
                  <Table.HeaderCell>Mémoire</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {health.services.map((svc) => (
                  <Table.Row key={svc.serviceId}>
                    <Table.Cell>
                      <div className="flex items-center gap-2">
                        <CircleMiniSolid
                          className={
                            svc.runningReplicas >= svc.desiredReplicas
                              ? "text-ui-tag-green-icon"
                              : "text-ui-tag-orange-icon"
                          }
                        />
                        {svc.name}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      {svc.runningReplicas} / {svc.desiredReplicas}
                    </Table.Cell>
                    <Table.Cell>{svc.avgCpuPct.toFixed(1)}%</Table.Cell>
                    <Table.Cell>
                      {(svc.totalMemBytes / 1024 / 1024).toFixed(0)} MiB
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </Container>
      )}
    </PageContainer>
  );
}
