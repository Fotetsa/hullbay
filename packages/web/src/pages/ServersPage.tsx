import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  Badge,
  FocusModal,
  Select,
  Switch,
  Textarea,
  RadioGroup,
} from "@medusajs/ui"
import { Plus, Trash, ServerStack, ArrowUpMini, ArrowDownMini } from "@medusajs/icons"
import { api, type Server } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { useProvisionLog } from "../lib/useProvisionLog"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ActionMenu } from "../components/ActionMenu"
import { ModalForm } from "../components/ModalForm"
import { useTranslation } from 'react-i18next'

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
  ready: "green",
  provisioning: "orange",
  error: "red",
  draining: "orange",
  down: "red",
}

export function ServersPage() {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ["servers"], queryFn: api.listServers })
  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.listClusters})
  const [open, setOpen] = useState(false)
  const { lines, clear } = useProvisionLog(open)

  // Formulaire
  const [name, setName] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState(22)
  const [user, setUser] = useState("root")
  const [credType, setCredType] = useState<"key" | "password">("key")
  const [privateKey, setPrivateKey] = useState("")
  const [password, setPassword] = useState("")
  const [asManager, setAsManager] = useState(false)

  //Choix des clusters (existe deja / nouveau)
  const [clusterMode, setClusterMode] = useState<"existing" | "new">(clusters?.length ? "existing" : "new")
  const [selectedClusterId, setSelectedClusterId] = useState<string>("");
  const [newClusterName, setNewClusterName] = useState("");

  const provision = useMutationToast({
    mutationFn: () =>
      api.provisionServer({
        name,
        host,
        port,
        user,
        role: clusterMode === "existing" && asManager ? "manager" : undefined,
        clusterId: clusterMode === "existing" ? selectedClusterId : undefined,
        newClusterName: clusterMode === "new" ? newClusterName: undefined,
        credential:
          credType === "key"
            ? { type: "key", privateKey }
            : { type: "password", password },
      }),
    success: t('servers.toast.provisionSuccess'),
    successDescription: t('servers.toast.provisionSuccessDesc'),
    invalidate: [["servers"], ["clusters"]],
    onSuccess: () => {
      // On efface immédiatement les secrets du state (jamais conservés côté front).
      setPrivateKey("")
      setPassword("")
    },
  })

  const removeServer = useConfirmDelete<Server>({
    mutationFn: (srv) => api.deleteServer(srv.id),
    success: t('servers.toast.removeSuccess'),
    invalidate: [["servers"]],
    confirm: (srv) => ({
      title: t('servers.confirm.removeTitle'),
      description: t('servers.confirm.removeDesc', { name: srv.name, host: srv.host }),
    }),
  })

  const setRole = useMutationToast({
    mutationFn: ({ id, role }: { id: string; role: "manager" | "worker" }) =>
      api.setServerRole(id, role),
    success: (r) => t('servers.toast.roleChanged', { role: r.role }),
    invalidate: [["servers"]],
  })

  const mgr = data?.managers
  const clusterNameById = new Map((clusters ?? []).map((c) => [c.id, c.name]))

  // Regroupage des serveurs par cluster pour l'affichage
  const serversByCluster = new Map<string, Server[]>();
  for (const srv of data?.servers ?? []) {
    const arr = serversByCluster.get(srv.clusterId) ?? [];
    arr.push(srv);
    serversByCluster.set(srv.clusterId, arr);
  }

  const canSubmit =
    name &&
    host &&
    (credType === "key" ? privateKey : password) &&
    (clusterMode === "existing" ? selectedClusterId : newClusterName.trim());

  return (
    <PageContainer>
      <PageHeader
        title={t('servers.pageTitle')}
        actions={
          <Button
            size="small"
            onClick={() => {
              clear();
              setOpen(true);
            }}
          >
            <Plus /> {t('servers.actions.add')}
          </Button>
        }
      />

      {mgr && mgr.total > 0 && (
        <Container className="mb-4 flex items-center justify-between p-4">
          <div>
            <Heading level="h3">{t('servers.quorum.title')}</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {t('servers.quorum.description', { reachable: mgr.reachable, total: mgr.total })}
            </Text>
          </div>
          <Badge color={mgr.quorumOk ? "green" : "red"}>
            {mgr.quorumOk ? t('servers.quorum.ok') : t('servers.quorum.atRisk')}
          </Badge>
        </Container>
      )}

      {/** Affichage groupé par cluster */}
      <div className="flex flex-col gap-6">
        {[...serversByCluster.entries()].map(([clusterId, servers]) => (
          <div key={clusterId}>
            <Heading level="h3" className="mb-2 text-ui-fg-subtle">
              {clusterNameById.get(clusterId) ?? clusterId}
            </Heading>
            <div className="flex flex-col gap-3">
              {servers.map((srv) => (
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
                                  label: t('servers.actions.promote'),
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
                                  label: t('servers.actions.demote'),
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
                            label: t('servers.actions.remove'),
                            icon: <Trash />,
                            variant: "danger" as const,
                            onClick: () => removeServer(srv),
                          },
                        ],
                      },
                    ]}
                  />
                </Container>
              ))}
            </div>
          </div>
        ))}
        {data?.servers.length === 0 && (
          <Text className="text-ui-fg-subtle">
            {t('servers.empty')}
          </Text>
        )}
      </div>

      <FocusModal open={open} onOpenChange={setOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading>{t('servers.modal.title')}</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm
              size="lg"
              onSubmit={() => canSubmit && provision.mutate()}
            >
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label size="small">{t('servers.modal.nameLabel')}</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('servers.modal.namePlaceholder')}
                  />
                </div>
                <div>
                  <Label size="small">{t('servers.modal.hostLabel')}</Label>
                  <Input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder={t('servers.modal.hostPlaceholder')}
                  />
                </div>
                <div>
                  <Label size="small">{t('servers.modal.portLabel')}</Label>
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label size="small">{t('servers.modal.userLabel')}</Label>
                  <Input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                  />
                </div>
              </div>

              {/* Choix du cluster */}
              <div className="rounded-lg border border-ui-border-base p-3">
                <Label size="small" className="mb-2 block">
                  {t('servers.modal.destinationLabel')}
                </Label>
                <RadioGroup
                  value={clusterMode}
                  onValueChange={(v) => setClusterMode(v as "existing" | "new")}
                >
                  <div className="flex items-center gap-2">
                    <RadioGroup.Item
                      value="existing"
                      id="existing"
                      disabled={!clusters?.length}
                    />
                    <Label htmlFor="existing">
                      {t('servers.modal.joinCluster')}
                    </Label>
                  </div>
                  {clusterMode === "existing" && (
                    <Select
                      value={selectedClusterId}
                      onValueChange={setSelectedClusterId}
                    >
                      <Select.Trigger>
                        <Select.Value placeholder={t('servers.modal.chooseClusterPlaceholder')} />
                      </Select.Trigger>
                      <Select.Content>
                        {clusters?.map((c) => (
                          <Select.Item key={c.id} value={c.id}>
                            {c.name}
                            {c.isDefault ? t('servers.modal.defaultSuffix') : ""}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <RadioGroup.Item value="new" id="new" />
                    <Label htmlFor="new">{t('servers.modal.createCluster')}</Label>
                  </div>
                  {clusterMode === "new" && (
                    <Input
                      value={newClusterName}
                      onChange={(e) => setNewClusterName(e.target.value)}
                      placeholder={t('servers.modal.newClusterPlaceholder')}
                    />
                  )}
                </RadioGroup>
              </div>

              <div>
                <Label size="small">
                  {t('servers.modal.authMethodLabel')}
                </Label>
                <Select
                  value={credType}
                  onValueChange={(v) => setCredType(v as "key" | "password")}
                >
                  <Select.Trigger>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="key">{t('servers.modal.sshKey')}</Select.Item>
                    <Select.Item value="password">{t('servers.modal.password')}</Select.Item>
                  </Select.Content>
                </Select>
              </div>

              {credType === "key" ? (
                <div>
                  <Label size="small">{t('servers.modal.privateKeyLabel')}</Label>
                  <Textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={5}
                  />
                </div>
              ) : (
                <div>
                  <Label size="small">{t('servers.modal.passwordLabel')}</Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              )}

              {clusterMode === "existing" && (
                <div className="flex items-center justify-between rounded-lg border border-ui-border-base p-3">
                  <div>
                    <Label size="small">{t('servers.modal.joinAsManagerLabel')}</Label>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {t('servers.modal.joinAsManagerDesc')}
                    </Text>
                  </div>
                  <Switch checked={asManager} onCheckedChange={setAsManager} />
                </div>
              )}

              <Text size="xsmall" className="text-ui-fg-muted">
                {t('servers.modal.infoNote')}
              </Text>

              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setOpen(false)}
                >
                  {t('servers.modal.closeButton')}
                </Button>
                <Button
                  type="submit"
                  isLoading={provision.isPending}
                  disabled={
                    !name ||
                    !host ||
                    (credType === "key" ? !privateKey : !password)
                  }
                >
                  {t('servers.modal.provisionButton')}
                </Button>
              </div>

              {lines.length > 0 && (
                <pre
                  className="mt-2 max-h-48 overflow-auto rounded-lg bg-ui-bg-base-pressed p-2 txt-compact-xsmall font-mono text-ui-fg-subtle"
                  aria-live="polite"
                  aria-label={t('servers.modal.logAriaLabel')}
                >
                  {lines.map((l) => l.message).join("\n")}
                </pre>
              )}
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </PageContainer>
  );
}