import { useState } from "react";
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
  toast,
} from "@medusajs/ui";
import { Plus, DecisionProcess, Trash } from "@medusajs/icons";
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

export function ClustersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: clusters, isLoading } = useQuery({
    queryKey: ["clusters"],
    queryFn: api.listClusters,
  });
  const { data: serversData } = useQuery({
    queryKey: ["servers"],
    queryFn: api.listServers,
  });

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

  const serverCountByCluster = new Map<string, number>();
  for (const srv of serversData?.servers ?? []) {
    serverCountByCluster.set(
      srv.clusterId,
      (serverCountByCluster.get(srv.clusterId) ?? 0) + 1,
    );
  }

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
            ? t("clusters.toast.deleteSuccessWithServers", {
                count: r.removedServers,
              })
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

      {isLoading ? (
        <Text className="text-ui-fg-subtle">{t("clusters.loading")}</Text>
      ) : clusters?.length === 0 ? (
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
                <DecisionProcess />
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
              {canDelete(cluster) && (
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
              )}
            </Container>
          ))}
        </div>
      )}

      {/* Modale de création — validation renforcée */}
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