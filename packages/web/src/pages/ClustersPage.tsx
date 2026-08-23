import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button, Container, Heading, Text, Badge } from "@medusajs/ui";
import { ServerStack, Trash } from "@medusajs/icons";
import { api } from "../lib/api";
import { useConfirmDelete } from "../lib/useConfirmDelete";
import { PageHeader, PageContainer } from "../components/PageHeader";
import { ActionMenu } from "../components/ActionMenu";
import { EmptyState } from "../components/EmptyState";
import type { Cluster } from "../lib/api";

const STATUS_COLOR: Record<Cluster["status"], "green" | "orange" | "red"> = {
  ready: "green",
  pending: "orange",
  failed: "red",
};

export function ClustersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: clusters, isLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.listClusters,
  });
  const { data: serversData } = useQuery({
    queryKey: ["servers"],
    queryFn: api.listServers,
  });

  const serverCountByCluster = new Map<string, number>();
  for (const srv of serversData?.servers ?? []) {
    serverCountByCluster.set(
      srv.clusterId,
      (serverCountByCluster.get(srv.clusterId) ?? 0) + 1,
    );
  }

  const removeCluster = useConfirmDelete<Cluster>({
    mutationFn: (c) => api.deleteCluster(c.id),
    success: (r) => {
      const result = r as Awaited<ReturnType<typeof api.deleteCluster>>;
      return result.removedServers > 0
        ? t("clusters.toast.deleteSuccessWithServers", {
            count: result.removedServers,
          })
        : t("clusters.toast.deleteSuccess");
    },
    invalidate: [["clusters"], ["servers"]],
    confirm: (c) => ({
      title: t("clusters.deleteConfirm.title"),
      description: t("clusters.deleteConfirm.description", {
        name: c.name,
        status: c.status,
      }),
    }),
  });

  return (
    <PageContainer>
      <PageHeader title={t("clusters.pageTitle")} />

      {isLoading ? (
        <Text className="text-ui-fg-subtle">{t("clusters.loading")}</Text>
      ) : clusters?.length === 0 ? (
        <Container className="p-0">
          <EmptyState
            icon={ServerStack}
            title={t("clusters.empty.title")}
            description={t("clusters.empty.description")}
          />
        </Container>
      ) : (
        <div className="flex flex-col gap-3">
          {clusters?.map((cluster) => (
            <Container
              key={cluster.id}
              className="flex items-center justify-between p-4"
            >
              <button
                type="button"
                onClick={() => navigate(`/clusters/${cluster.id}`)}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <ServerStack />
                <div>
                  <div className="flex items-center gap-2">
                    <Heading level="h3">{cluster.name}</Heading>
                    {cluster.isDefault && (
                      <Badge size="2xsmall">
                        {t("clusters.badge.default")}
                      </Badge>
                    )}
                    <Badge size="2xsmall" color={STATUS_COLOR[cluster.status]}>
                      {cluster.status}
                    </Badge>
                  </div>
                  <Text size="small" className="text-ui-fg-subtle">
                    {t("clusters.serverCount", {
                      count: serverCountByCluster.get(cluster.id) ?? 0,
                    })}
                  </Text>
                </div>
              </button>
              {cluster.status !== "ready" && (
                <ActionMenu
                  groups={[
                    {
                      actions: [
                        {
                          label: t("clusters.actions.delete"),
                          icon: <Trash />,
                          variant: "danger" as const,
                          onClick: () => removeCluster(cluster),
                        },
                      ],
                    },
                  ]}
                />
              )}
            </Container>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
