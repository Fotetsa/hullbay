import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text, Badge, Select } from "@medusajs/ui"
import { Plus, Trash, Key } from "@medusajs/icons"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ListContainer, ListRow } from "../components/ListContainer"
import { ActionMenu } from "../components/ActionMenu"
import { EmptyState } from "../components/EmptyState"

/**
 * Gestion des Docker Secrets : valeurs sensibles stockées HORS labels/env.
 * La valeur est write-only (jamais réaffichée). Référencée par nom dans la config
 * d'un conteneur (montée en /run/secrets/<nom>). Swarm la chiffre au repos.
 */
export function SecretsPage() {
   const { data: clusters } = useQuery({
     queryKey: ["clusters"],
     queryFn: api.listClusters,
   });
  const [clusterId, setClusterId] = useState<string>("")

  const effectiveClusterId =
    clusterId ||
    clusters?.find((c) => c.isDefault)?.id ||
    clusters?.[0]?.id || "";

  const { data: secrets } = useQuery({
    queryKey: ["secrets", effectiveClusterId],
    queryFn: () => api.listSecrets(effectiveClusterId),
    enabled: !!effectiveClusterId,
  })

  const [name, setName] = useState("")
  const [value, setValue] = useState("")

  const save = useMutationToast({
    mutationFn: () => api.setSecret(effectiveClusterId, { name, value }),
    success: "Secret enregistré",
    invalidate: [["secrets", effectiveClusterId]],
    onSuccess: () => {
      setName("")
      setValue("")
    },
  })

  const removeSecret = useConfirmDelete<string>({
    mutationFn: (n) => api.deleteSecret(effectiveClusterId, n),
    success: "Secret retiré",
    invalidate: [["secrets", effectiveClusterId]],
    confirm: (n) => ({
      title: "Supprimer ce secret ?",
      description: `« ${n} » sera supprimé. Un service qui le référence encore échouera au prochain déploiement.`,
    }),
  })

  return (
    <PageContainer size="2xl">
      <PageHeader title="Secrets" />

      {/** Selection des  clusters visible (si plusieurs existent) */}
      {clusters && clusters.length > 1 && (
        <div className="mb-4 max-w-xs">
          <Label size="small">Cluster</Label>
          <Select value={effectiveClusterId} onValueChange={setClusterId}>
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {clusters.map((c) => (
                <Select.Item key={c.id} value={c.id}>
                  {c.name}
                  {c.isDefault ? " (défaut)" : ""}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>
        </div>
      )}

      <div className="mb-6">
        <ListContainer
          title="Secrets"
          subtitle={secrets ? `${secrets.length} secret(s)` : undefined}
          isEmpty={secrets?.length === 0}
          empty={
            <EmptyState
              icon={Key}
              title="Aucun secret"
              description="Crée un secret puis référence-le par son nom dans un conteneur (monté en /run/secrets)."
            />
          }
        >
          {secrets?.map((s) => (
            <ListRow key={s.id}>
              <div className="flex items-center gap-2">
                <Key className="text-ui-fg-muted" />
                <Heading level="h3">{s.name}</Heading>
                <Badge size="2xsmall" color="green">
                  chiffré
                </Badge>
              </div>
              <ActionMenu
                groups={[
                  {
                    actions: [
                      {
                        label: "Supprimer",
                        icon: <Trash />,
                        variant: "danger",
                        onClick: () => removeSecret(s.name),
                      },
                    ],
                  },
                ]}
              />
            </ListRow>
          ))}
        </ListContainer>
      </div>

      <Container className="p-6">
        <Heading level="h3" className="mb-3">
          Ajouter / remplacer un secret
        </Heading>
        <div className="flex flex-col gap-3">
          <div>
            <Label size="small">Nom</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="DB_PASSWORD"
            />
            <Text size="xsmall" className="mt-1 text-ui-fg-muted">
              Monté dans le conteneur en /run/secrets/&lt;nom&gt;.
            </Text>
          </div>
          <div>
            <Label size="small">Valeur</Label>
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="(jamais réaffichée)"
            />
          </div>
          <Button
            onClick={() => save.mutate()}
            isLoading={save.isPending}
            disabled={!name.trim() || !value || !effectiveClusterId}
          >
            <Plus /> Enregistrer
          </Button>
        </div>
      </Container>
    </PageContainer>
  );
}
