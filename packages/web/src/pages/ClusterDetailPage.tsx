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
  DocumentText,
  Plus,
} from "@medusajs/icons";
import { api, type Server, type SystemInfoSnapshot } from "../lib/api";
import { useMutationToast } from "../lib/useMutationToast";
import { useConfirmDelete } from "../lib/useConfirmDelete";
import { PageHeader, PageContainer } from "../components/PageHeader";
import { ActionMenu } from "../components/ActionMenu";
import { AddServerModal } from "../components/servers/AddServerModal";

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

function ServerSystemInfo({ info }: { info: SystemInfoSnapshot | null }) {
  const { t } = useTranslation()
  if (!info) return null

  const ramPct = info.ramTotalMb && info.ramUsedMb
    ? Math.round((info.ramUsedMb / info.ramTotalMb) * 100)
    : null
  const diskPct = info.diskTotalGb && info.diskUsedGb
    ? Math.round((info.diskUsedGb / info.diskTotalGb) * 100)
    : null

  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ui-fg-muted" data-testid="server-system-info">
      {info.os && <span>{info.os}</span>}
      {info.cpuCores !== null && <span>{t("clusters.detail.server.sysinfo.cpu", { count: info.cpuCores })}</span>}
      {info.ramTotalMb !== null && (
        <span>
          RAM {info.ramUsedMb ?? "?"}/{info.ramTotalMb} Mo{ramPct !== null ? ` (${ramPct}%)` : ""}
        </span>
      )}
      {info.diskTotalGb !== null && (
        <span>
          {t("clusters.detail.server.sysinfo.disk")} {info.diskUsedGb ?? "?"}/{info.diskTotalGb} Go{diskPct !== null ? ` (${diskPct}%)` : ""}
        </span>
      )}
      {info.swapTotalMb !== null && info.swapTotalMb > 0 && (
        <span>Swap {info.swapUsedMb ?? "?"}/{info.swapTotalMb} Mo</span>
      )}
    </div>
  )
}

export function ClusterDetailPage() {
  const { t } = useTranslation();
  const { clusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>("overview");

  const [addServerOpen, setAddServerOpen] = useState(false);

  const { data: clusters, isLoading: clustersLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.listClusters,
  });
  const { data: serversData, isLoading: serversLoading } = useQuery({
    queryKey: ["servers"],
    queryFn: api.listServers,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ["health"],
    queryFn: api.clusterHealth,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
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

  // Calculé dynamiquement (pas depuis cluster.status), reflète l'état
  // réel, même si un manager a été retiré depuis la dernière transition de
  // statut du cluster.
  const hasActiveManager = servers.some(
    (s) => s.role === "manager" && s.status === "ready",
  );

  const managersTotal = servers.filter((s) => s.role === "manager").length;
  const managersReachable =
    health?.nodes.filter((n) => n.role === "manager" && n.state === "ready")
      .length ?? 0;
  const quorumOk = managersTotal > 0 && managersReachable > managersTotal / 2;

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
            <Button size="small" onClick={() => setAddServerOpen(true)}>
              <Plus /> {t("clusters.detail.addServer.button")}
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => navigate("/audit")}
            >
              <DocumentText /> {t("clusters.detail.viewAuditLog")}
            </Button>
            <Badge
              color={CLUSTER_STATUS_COLOR[cluster.status] ?? "grey"}
              size="small"
            >
              {cluster.isDefault
                ? t("clusters.detail.defaultBadge")
                : t("clusters.detail.clusterBadge")}
            </Badge>
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
          {managersTotal > 0 && !quorumOk && (
            <Container className="border-2 border-ui-fg-error bg-ui-bg-error/20 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <Text weight="plus" className="text-ui-fg-error">
                    {t("clusters.detail.quorum.atRiskBanner")}
                  </Text>
                  <Text size="small" className="text-ui-fg-subtle">
                    {t("clusters.detail.quorum.description", {
                      reachable: managersReachable,
                      total: managersTotal,
                    })}
                  </Text>
                </div>
                <Badge color="red">{t("clusters.detail.quorum.atRisk")}</Badge>
              </div>
            </Container>
          )}

          {managersTotal > 0 && (
            <Container className="flex items-center justify-between p-4">
              <div>
                <Heading level="h3">
                  {t("clusters.detail.quorum.title")}
                </Heading>
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
                          {t(`clusters.detail.server.status.${srv.status}`, {
                            defaultValue: srv.status,
                          })}
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
                      <ServerSystemInfo info={srv.systemInfo} />
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
      <AddServerModal
        open={addServerOpen}
        onOpenChange={setAddServerOpen}
        clusterId={clusterId!}
        forceManager={!hasActiveManager}
      />
    </PageContainer>
  );
}