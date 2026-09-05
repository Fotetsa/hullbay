import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Container, Heading, Text, Badge, Table } from "@medusajs/ui";
import {
  ArrowDownLeft,
  ServerSolid,
  ArrowUpMini,
  ArrowDownMini,
  Trash,
  CircleMiniSolid,
  Plus,
} from "@medusajs/icons";
import { api, type Server } from "../lib/api";
import { useMutationToast } from "../lib/useMutationToast";
import { useConfirmDelete } from "../lib/useConfirmDelete";
import { PageHeader, PageContainer } from "../components/PageHeader";
import { ActionMenu } from "../components/ActionMenu";

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
  ready: "green",
  provisioning: "orange",
  error: "red",
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
  const { t } = useTranslation();
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

  const removeServer = useConfirmDelete<Server>({
    mutationFn: (srv) => api.deleteServer(srv.id),
    success: t("clusters.detail.toast.serverRemoved"),
    invalidate: [["servers"], ["health"]],
    confirm: (srv) => ({
      title: t("clusters.detail.removeServerConfirm.title"),
      description: t("clusters.detail.removeServerConfirm.description", {
        name: srv.name,
        host: srv.host,
      }),
    }),
  });

  const setRole = useMutationToast({
    mutationFn: ({ id, role }: { id: string; role: "manager" | "worker" }) =>
      api.setServerRole(id, role),
    success: (r) => t("clusters.detail.toast.roleChanged", { role: r.role }),
    invalidate: [["servers"], ["health"]],
  });

  const isLoading = clustersLoading || serversLoading || healthLoading;

  if (isLoading) {
    return (
      <PageContainer>
        <Text className="text-ui-fg-subtle">
          {t("clusters.detail.loading")}
        </Text>
      </PageContainer>
    );
  }

  const cluster = clusters?.find((c) => c.id === clusterId);

  if (!cluster) {
    return (
      <PageContainer>
        <Container className="p-6 text-center">
          <Heading level="h2" className="mb-2">
            {t("clusters.detail.notFound.title")}
          </Heading>
          <Text className="text-ui-fg-subtle mb-4">
            {t("clusters.detail.notFound.description")}
          </Text>
          <Button onClick={() => navigate("/clusters")}>
            {t("clusters.detail.backToClusters")}
          </Button>
        </Container>
      </PageContainer>
    );
  }

  const servers = (serversData?.servers ?? []).filter(
    (s) => s.clusterId === clusterId,
  );
  const health = healthData?.clusters.find((c) => c.clusterId === clusterId);

  const managersTotal = servers.filter((s) => s.role === "manager").length;
  const managersReachable =
    health?.nodes.filter((n) => n.role === "manager" && n.state === "ready")
      .length ?? 0;
  // Aligné sur la garde backend (docker-engine.managerHealth) : le quorum exige
  // une MAJORITÉ STRICTE des managers joignables — sans aucun manager, il n'y a
  // pas de quorum (un Swarm exige au moins un manager).
  const quorumOk =
    managersTotal > 0 && managersReachable > Math.floor(managersTotal / 2);

  return (
    <PageContainer>
      <div className="mb-2 flex items-center gap-2">
        <Button
          variant="transparent"
          size="small"
          onClick={() => navigate("/clusters")}
        >
          <ArrowDownLeft /> {t("clusters.detail.back")}
        </Button>
      </div>

      <PageHeader
        title={cluster.name}
        actions={
          <div className="flex items-center gap-2">
            <Badge
              color={CLUSTER_STATUS_COLOR[cluster.status] ?? "grey"}
              size="small"
            >
              {cluster.isDefault
                ? t("clusters.detail.defaultBadge")
                : t("clusters.detail.clusterBadge")}
            </Badge>
            <Button
              variant="primary"
              size="small"
              onClick={() => navigate(`/servers?cluster=${cluster.id}`)}
            >
              <Plus /> {t("clusters.detail.addServer")}
            </Button>
          </div>
        }
      />

      <div className="mb-4 flex gap-1 border-b border-ui-border-base">
        {(
          [
            ["overview", t("clusters.detail.tabs.overview")],
            ["services", t("clusters.detail.tabs.services")],
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
                <Heading level="h3">{t("clusters.detail.quorum.title")}</Heading>
                <Text size="small" className="text-ui-fg-subtle">
                  {t("clusters.detail.quorum.description", {
                    reachable: managersReachable,
                    total: managersTotal,
                  })}
                </Text>
              </div>
              <Badge color={quorumOk ? "green" : "red"}>
                {quorumOk
                  ? t("clusters.detail.quorum.ok")
                  : t("clusters.detail.quorum.atRisk")}
              </Badge>
            </Container>
          )}

          {!health?.swarmActive && (
            <Container className="p-4">
              <Text className="text-ui-fg-error">
                {t("clusters.detail.unreachable")}
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
                    <ServerSolid />
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
                            {t("clusters.detail.server.leader")}
                          </Badge>
                        )}
                      </div>
                      <Text size="small" className="text-ui-fg-subtle">
                        {srv.user}@{srv.host}:{srv.port}
                      </Text>
                      {nodeHealth && nodeHealth.memoryBytes > 0 && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          {[
                            t("clusters.detail.server.specs.cpus", {
                              cpus:
                                Math.round(nodeHealth.nanoCpus / 1e9) || "?",
                            }),
                            t("clusters.detail.server.specs.ram", {
                              ram: `${(
                                nodeHealth.memoryBytes /
                                1024 /
                                1024 /
                                1024
                              ).toFixed(0)} GiB`,
                            }),
                            t("clusters.detail.server.specs.os", {
                              os: nodeHealth.os,
                              arch: nodeHealth.architecture,
                              version: nodeHealth.dockerVersion,
                            }),
                          ].join(" · ")}
                        </Text>
                      )}
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
                                  label: t("clusters.detail.server.promote"),
                                  icon: <ArrowUpMini />,
                                  onClick: () =>
                                    setRole.mutate({
                                      id: srv.id,
                                      role: "manager",
                                    }),
                                },
                              ]
                            : []),
                          ...(srv.swarmNodeId &&
                            srv.role === "manager" &&
                            // Garde A5 : on masque "Rétrograder" sur le DERNIER
                            // manager — la rétrogradation est bloquée en back
                            // (409 LastManagerError), inutile de la proposer en UI.
                            managersTotal > 1
                            ? [
                                {
                                  label: t("clusters.detail.server.demote"),
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
                            label: t("clusters.detail.server.remove"),
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
                {t("clusters.detail.server.empty")}
              </Text>
            )}
          </div>
        </div>
      )}

      {tab === "services" && (
        <Container className="p-0">
          {!health?.services.length ? (
            <Text className="p-6 text-ui-fg-subtle">
              {t("clusters.detail.services.empty")}
            </Text>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>
                    {t("clusters.detail.services.service")}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t("clusters.detail.services.replicas")}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t("clusters.detail.services.avgCpu")}
                  </Table.HeaderCell>
                  <Table.HeaderCell>
                    {t("clusters.detail.services.memory")}
                  </Table.HeaderCell>
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