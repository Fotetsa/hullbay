import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  Badge,
  FocusModal,
  Textarea,
  RadioGroup,
  Switch,
  Select,
  toast,
} from "@medusajs/ui";
import { Plus, DecisionProcess, Trash, ArrowUpMini, ArrowDownMini } from "@medusajs/icons";
import { api } from "../lib/api";
import { useMutationToast } from "../lib/useMutationToast";
import { useProvisionLog } from "../lib/useProvisionLog";
import {
  isValidHostnameOrIp,
  isValidPort,
  isValidClusterName,
} from "../lib/validation";
import { PageHeader, PageContainer } from "../components/PageHeader";
import { ActionMenu } from "../components/ActionMenu";
import { EmptyState } from "../components/EmptyState";
import { ModalForm } from "../components/ModalForm";
import type { Cluster } from "../lib/api";

const STATUS_COLOR: Record<
  Cluster["status"],
  "green" | "orange" | "red" | "grey"
> = {
  ready: "green",
  pending: "orange",
  failed: "red",
  deleting: "grey",
};

type SortKey = "name" | "status" | "servers";
type SortDir = "asc" | "desc";

/** Silhouette de carte grisée pendant le chargement — meilleure sensation de
 * réactivité qu'un simple texte "Chargement…". Pure CSS (animate-pulse
 * Tailwind, déjà utilisé ailleurs dans le projet), aucune dépendance externe. */
function ClusterCardSkeleton() {
  return (
    <Container className="flex items-center justify-between p-4">
      <div className="flex flex-1 items-center gap-3">
        <div className="h-6 w-6 shrink-0 animate-pulse rounded bg-ui-bg-base-pressed" />
        <div className="flex flex-col gap-2">
          <div className="h-4 w-32 animate-pulse rounded bg-ui-bg-base-pressed" />
          <div className="h-3 w-20 animate-pulse rounded bg-ui-bg-base-pressed" />
        </div>
      </div>
    </Container>
  );
}

export function ClustersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Polling léger (20s) + refetch au retour de focus de l'onglet, un
  // cluster qui passe pending à ready pendant que la page est ouverte devient
  // visible sans action manuelle.
  const { data: clusters, isLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.listClusters,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
  const { data: serversData } = useQuery({
    queryKey: ["servers"],
    queryFn: api.listServers,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  // Recherche / filtre / tri
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Cluster["status"]>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const [open, setOpen] = useState(false);
  const { lines, clear } = useProvisionLog(open);
  const [newClusterName, setNewClusterName] = useState("");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("root");
  const [credType, setCredType] = useState<"key" | "password">("key");
  const [privateKey, setPrivateKey] = useState("");
  const [password, setPassword] = useState("");

  const clusterNameError =
    newClusterName && !isValidClusterName(newClusterName)
      ? t("clusters.createModal.errors.name")
      : null;
  const hostError =
    host && !isValidHostnameOrIp(host)
      ? t("clusters.createModal.errors.host")
      : null;
  const portError = !isValidPort(port)
    ? t("clusters.createModal.errors.port")
    : null;

  const provision = useMutationToast({
    mutationFn: () =>
      api.provisionServer({
        name,
        host,
        port,
        user,
        newClusterName,
        credential:
          credType === "key"
            ? { type: "key", privateKey }
            : { type: "password", password },
      }),
    success: t("clusters.toast.creationStarted"),
    invalidate: [["clusters"], ["servers"]],
    onSuccess: () => {
      setPrivateKey("");
      setPassword("");
    },
  });

  const canSubmit =
    isValidClusterName(newClusterName) &&
    Boolean(name.trim()) &&
    isValidHostnameOrIp(host) &&
    isValidPort(port) &&
    (credType === "key" ? Boolean(privateKey) : Boolean(password));

  const serverCountByCluster = useMemo(() => {
    const map = new Map<string, number>();
    for (const srv of serversData?.servers ?? []) {
      map.set(srv.clusterId, (map.get(srv.clusterId) ?? 0) + 1);
    }
    return map;
  }, [serversData]);


  const visibleClusters = useMemo(() => {
    let list = clusters ?? [];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      list = list.filter((c) => c.status === statusFilter);
    }

    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name);
      else if (sortKey === "status") cmp = a.status.localeCompare(b.status);
      else cmp = (serverCountByCluster.get(a.id) ?? 0) - (serverCountByCluster.get(b.id) ?? 0);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [clusters, search, statusFilter, sortKey, sortDir, serverCountByCluster]);

  const canDelete = (c: Cluster) =>
    c.status !== "ready" && c.status !== "deleting" && !c.isDefault;

  const [deleteTarget, setDeleteTarget] = useState<Cluster | null>(null);
  const [teardown, setTeardown] = useState(false);

  const deleteMut = useMutation({
    mutationFn: () => api.deleteCluster(deleteTarget!.id, { teardown }),
    onSuccess: (r) => {
      toast.success(
        r.status === "deleting"
          ? t("clusters.toast.teardownStarted", { count: r.removedServers })
          : r.removedServers > 0
            ? t("clusters.toast.deleteSuccessWithServers", { count: r.removedServers })
            : t("clusters.toast.deleteSuccess"),
      );
      qc.invalidateQueries({ queryKey: ["clusters"] });
      qc.invalidateQueries({ queryKey: ["servers"] });
      setDeleteTarget(null);
      setTeardown(false);
    },
    onError: (err: unknown) => {
      toast.error(t("clusters.toast.deleteError"), {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const serverCountOfTarget = deleteTarget
    ? (serverCountByCluster.get(deleteTarget.id) ?? 0)
    : 0;

  const hasAnyCluster = (clusters?.length ?? 0) > 0;
  const hasFilteredResults = visibleClusters.length > 0;

  return (
    <PageContainer>
      <PageHeader
        title={t("clusters.pageTitle")}
        actions={
          <Button
            size="small"
            onClick={() => {
              clear();
              setOpen(true);
            }}
          >
            <Plus /> {t("clusters.actions.create")}
          </Button>
        }
      />

      {/* Barre recherche + filtre + tri — masquée si aucun cluster n'existe du tout*/}
      {hasAnyCluster && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("clusters.search.placeholder")}
            className="max-w-xs"
            aria-label={t("clusters.search.placeholder")}
            type="search"
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
          >
            <Select.Trigger className="w-40">
              <Select.Value placeholder={t("clusters.filter.statusLabel")} />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="all">{t("clusters.filter.all")}</Select.Item>
              <Select.Item value="ready">
                {t("clusters.status.ready")}
              </Select.Item>
              <Select.Item value="pending">
                {t("clusters.status.pending")}
              </Select.Item>
              <Select.Item value="failed">
                {t("clusters.status.failed")}
              </Select.Item>
              <Select.Item value="deleting">
                {t("clusters.status.deleting")}
              </Select.Item>
            </Select.Content>
          </Select>
          <Select
            value={sortKey}
            onValueChange={(v) => setSortKey(v as SortKey)}
          >
            <Select.Trigger className="w-40">
              <Select.Value placeholder={t("clusters.sort.label")} />
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="name">
                {t("clusters.sort.byName")}
              </Select.Item>
              <Select.Item value="status">
                {t("clusters.sort.byStatus")}
              </Select.Item>
              <Select.Item value="servers">
                {t("clusters.sort.byServers")}
              </Select.Item>
            </Select.Content>
          </Select>
          <Button
            variant="secondary"
            size="small"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            aria-label={
              sortDir === "asc"
                ? t("clusters.sort.ascending")
                : t("clusters.sort.descending")
            }
          >
            {sortDir === "asc" ? <ArrowUpMini /> : <ArrowDownMini />}
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-3">
          <ClusterCardSkeleton />
          <ClusterCardSkeleton />
          <ClusterCardSkeleton />
        </div>
      ) : !hasAnyCluster ? (
        <Container className="p-0">
          <EmptyState
            icon={DecisionProcess}
            title={t("clusters.empty.title")}
            description={t("clusters.empty.description")}
            action={
              <Button
                size="small"
                onClick={() => {
                  clear();
                  setOpen(true);
                }}
              >
                <Plus /> {t("clusters.actions.create")}
              </Button>
            }
          />
        </Container>
      ) : !hasFilteredResults ? (
        <Container className="p-6 text-center">
          <Text className="text-ui-fg-subtle">
            {t("clusters.search.noResults")}
          </Text>
        </Container>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleClusters.map((cluster) => (
            <Container
              key={cluster.id}
              data-testid={`cluster-row-${cluster.id}`}
              className="flex items-center justify-between p-4"
            >
              <button
                type="button"
                onClick={() => navigate(`/clusters/${cluster.id}`)}
                className="flex flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ui-fg-interactive rounded-md p-2 -m-2"
              >
                <DecisionProcess className="text-ui-fg-subtle" />
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <Heading level="h3" className="text-ui-fg-base">
                      {cluster.name}
                    </Heading>
                    {cluster.isDefault && (
                      <Badge size="2xsmall" color="grey">
                        {t("clusters.badge.default")}
                      </Badge>
                    )}
                    <Badge size="2xsmall" color={STATUS_COLOR[cluster.status]}>
                      {t(`clusters.status.${cluster.status}`)}
                    </Badge>
                  </div>
                  <Text size="small" className="text-ui-fg-subtle mt-0.5">
                    {t("clusters.serverCount", {
                      count: serverCountByCluster.get(cluster.id) ?? 0,
                    })}
                  </Text>
                </div>
              </button>
              {canDelete(cluster) && (
                <div data-testid={`cluster-delete-trigger-${cluster.id}`}>
                  <ActionMenu
                    groups={[
                      {
                        actions: [
                          {
                            label: t("clusters.actions.delete"),
                            icon: <Trash />,
                            variant: "danger" as const,
                            onClick: () => {
                              setDeleteTarget(cluster);
                              setTeardown(false);
                            },
                          },
                        ],
                      },
                    ]}
                  />
                </div>
              )}
            </Container>
          ))}
        </div>
      )}

      <FocusModal open={open} onOpenChange={setOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading>{t("clusters.createModal.title")}</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm
              size="lg"
              onSubmit={(e?: React.FormEvent) => {
                e?.preventDefault?.();
                if (canSubmit) provision.mutate();
              }}
            >
              <div>
                <Label size="small">
                  {t("clusters.createModal.clusterNameLabel")}
                </Label>
                <Input
                  value={newClusterName}
                  onChange={(e) => setNewClusterName(e.target.value)}
                  placeholder="Cluster EU-2"
                />
                {clusterNameError && (
                  <Text size="xsmall" className="mt-1 text-ui-fg-error">
                    {clusterNameError}
                  </Text>
                )}
              </div>
              <Text size="xsmall" className="text-ui-fg-muted">
                {t("clusters.createModal.hint")}
              </Text>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label size="small">
                    {t("clusters.createModal.serverNameLabel")}
                  </Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="manager-1"
                  />
                </div>
                <div>
                  <Label size="small">
                    {t("clusters.createModal.hostLabel")}
                  </Label>
                  <Input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="203.0.113.10"
                  />
                  {hostError && (
                    <Text size="xsmall" className="mt-1 text-ui-fg-error">
                      {hostError}
                    </Text>
                  )}
                </div>
                <div>
                  <Label size="small">
                    {t("clusters.createModal.portLabel")}
                  </Label>
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                  {portError && (
                    <Text size="xsmall" className="mt-1 text-ui-fg-error">
                      {portError}
                    </Text>
                  )}
                </div>
                <div>
                  <Label size="small">
                    {t("clusters.createModal.userLabel")}
                  </Label>
                  <Input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <Label size="small">
                  {t("clusters.createModal.authMethodLabel")}
                </Label>
                <RadioGroup
                  value={credType}
                  onValueChange={(v) => setCredType(v as "key" | "password")}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroup.Item value="key" id="ck-key" />
                    <Label htmlFor="ck-key">
                      {t("clusters.createModal.sshKey")}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroup.Item value="password" id="ck-pw" />
                    <Label htmlFor="ck-pw">
                      {t("clusters.createModal.password")}
                    </Label>
                  </div>
                </RadioGroup>
              </div>
              {credType === "key" ? (
                <Textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={5}
                />
              ) : (
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setOpen(false)}
                >
                  {t("common.close")}
                </Button>
                <Button
                  type="submit"
                  isLoading={provision.isPending}
                  disabled={!canSubmit}
                >
                  {t("clusters.actions.create")}
                </Button>
              </div>
              {lines.length > 0 && (
                <pre
                  className="mt-2 max-h-48 overflow-auto rounded-lg bg-ui-bg-base-pressed p-2 txt-compact-xsmall font-mono text-ui-fg-subtle"
                  aria-live="polite"
                >
                  {lines.map((l) => l.message).join("\n")}
                </pre>
              )}
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>

      <FocusModal
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading>{t("clusters.deleteConfirm.title")}</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <div className="flex flex-col gap-4">
              <Text>
                {t("clusters.deleteConfirm.description", {
                  name: deleteTarget?.name,
                  status: deleteTarget?.status,
                })}
              </Text>
              {serverCountOfTarget > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-ui-border-base p-3">
                  <div>
                    <Label size="small">
                      {t("clusters.deleteConfirm.teardownLabel", {
                        count: serverCountOfTarget,
                      })}
                    </Label>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {t("clusters.deleteConfirm.teardownHint")}
                    </Text>
                  </div>
                  <Switch checked={teardown} onCheckedChange={setTeardown} />
                </div>
              )}
              {serverCountOfTarget > 0 && !teardown && (
                <Text size="xsmall" className="text-ui-fg-error">
                  {t("clusters.deleteConfirm.teardownRequired")}
                </Text>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  onClick={() => setDeleteTarget(null)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  isLoading={deleteMut.isPending}
                  disabled={serverCountOfTarget > 0 && !teardown}
                  onClick={() => deleteMut.mutate()}
                >
                  {t("clusters.actions.delete")}
                </Button>
              </div>
            </div>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </PageContainer>
  );
}