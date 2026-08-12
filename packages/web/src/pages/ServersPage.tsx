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

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
  ready: "green",
  provisioning: "orange",
  error: "red",
  draining: "orange",
  down: "red",
}

export function ServersPage() {
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
    success: "Provisioning lancé",
    successDescription: "Suis les étapes ci-dessous.",
    invalidate: [["servers"], ["clusters"]],
    onSuccess: () => {
      // On efface immédiatement les secrets du state (jamais conservés côté front).
      setPrivateKey("")
      setPassword("")
    },
  })

  const removeServer = useConfirmDelete<Server>({
    mutationFn: (srv) => api.deleteServer(srv.id),
    success: "Serveur retiré",
    invalidate: [["servers"]],
    confirm: (srv) => ({
      title: "Retirer ce serveur ?",
      description: `« ${srv.name} » (${srv.host}) sera drainé puis retiré du cluster Swarm. Les tasks qui y tournent seront reschedulées sur les autres nœuds. Action destructive.`,
    }),
  })

  const setRole = useMutationToast({
    mutationFn: ({ id, role }: { id: string; role: "manager" | "worker" }) =>
      api.setServerRole(id, role),
    success: (r) => `Rôle changé : ${r.role}`,
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
        title="Serveurs"
        actions={
          <Button
            size="small"
            onClick={() => {
              clear();
              setOpen(true);
            }}
          >
            <Plus /> Ajouter un serveur
          </Button>
        }
      />

      {mgr && mgr.total > 0 && (
        <Container className="mb-4 flex items-center justify-between p-4">
          <div>
            <Heading level="h3">Quorum (HA control plane)</Heading>
            <Text size="small" className="text-ui-fg-subtle">
              {mgr.reachable}/{mgr.total} managers joignables. Recommandé :
              nombre impair (3 tolère 1 panne, 5 en tolère 2).
            </Text>
          </div>
          <Badge color={mgr.quorumOk ? "green" : "red"}>
            {mgr.quorumOk ? "quorum OK" : "quorum à risque"}
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
              ))}
            </div>
          </div>
        ))}
        {data?.servers.length === 0 && (
          <Text className="text-ui-fg-subtle">
            Aucun serveur. Le premier ajouté devient le manager de son cluster.
          </Text>
        )}
      </div>

      <FocusModal open={open} onOpenChange={setOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading>Ajouter un serveur</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm
              size="lg"
              onSubmit={() => canSubmit && provision.mutate()}
            >
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label size="small">Nom</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="vps-paris-1"
                  />
                </div>
                <div>
                  <Label size="small">Hôte (IP / domaine)</Label>
                  <Input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="203.0.113.10"
                  />
                </div>
                <div>
                  <Label size="small">Port SSH</Label>
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label size="small">Utilisateur</Label>
                  <Input
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                  />
                </div>
              </div>

              {/* Choix du cluster */}
              <div className="rounded-lg border border-ui-border-base p-3">
                <Label size="small" className="mb-2 block">
                  Destination
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
                      Rejoindre un cluster existant
                    </Label>
                  </div>
                  {clusterMode === "existing" && (
                    <Select
                      value={selectedClusterId}
                      onValueChange={setSelectedClusterId}
                    >
                      <Select.Trigger>
                        <Select.Value placeholder="Choisir un cluster" />
                      </Select.Trigger>
                      <Select.Content>
                        {clusters?.map((c) => (
                          <Select.Item key={c.id} value={c.id}>
                            {c.name}
                            {c.isDefault ? " (défaut)" : ""}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <RadioGroup.Item value="new" id="new" />
                    <Label htmlFor="new">Créer un nouveau cluster</Label>
                  </div>
                  {clusterMode === "new" && (
                    <Input
                      value={newClusterName}
                      onChange={(e) => setNewClusterName(e.target.value)}
                      placeholder="Nom du nouveau cluster (ex: Cluster CM-2)"
                    />
                  )}
                </RadioGroup>
              </div>

              <div>
                <Label size="small">
                  Méthode d'authentification (utilisée une seule fois, jamais
                  stockée)
                </Label>
                <Select
                  value={credType}
                  onValueChange={(v) => setCredType(v as "key" | "password")}
                >
                  <Select.Trigger>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="key">Clé SSH privée</Select.Item>
                    <Select.Item value="password">Mot de passe</Select.Item>
                  </Select.Content>
                </Select>
              </div>

              {credType === "key" ? (
                <div>
                  <Label size="small">Clé privée SSH</Label>
                  <Textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    rows={5}
                  />
                </div>
              ) : (
                <div>
                  <Label size="small">Mot de passe</Label>
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
                    <Label size="small">Rejoindre comme manager (HA)</Label>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      Ajoute un manager au quorum Raft (résilience du control
                      plane). Sinon = worker. Le 1er serveur est toujours
                      manager.
                    </Text>
                  </div>
                  <Switch checked={asManager} onCheckedChange={setAsManager} />
                </div>
              )}

              <Text size="xsmall" className="text-ui-fg-muted">
                Cette information sert uniquement au provisioning (installer
                Docker, rejoindre le cluster). Elle n'est jamais enregistrée.
                L'outil installe ensuite sa propre clé de maintenance.
              </Text>

              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setOpen(false)}
                >
                  Fermer
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
                  Provisionner
                </Button>
              </div>

              {lines.length > 0 && (
                <pre
                  className="mt-2 max-h-48 overflow-auto rounded-lg bg-ui-bg-base-pressed p-2 txt-compact-xsmall font-mono text-ui-fg-subtle"
                  aria-live="polite"
                  aria-label="Journal de provisioning"
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
