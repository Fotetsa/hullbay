import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Heading, Input, Label, Text, Badge } from "@medusajs/ui"
import { Plus, Trash, CircleStack } from "@medusajs/icons"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ListContainer, ListRow } from "../components/ListContainer"
import { ActionMenu } from "../components/ActionMenu"
import { EmptyState } from "../components/EmptyState"
import { useTranslation } from "react-i18next"
import { AppDrawer } from "../components/AppDrawer"

/**
 * Gestion des registres de conteneurs (Docker Hub, GHCR, registres privés).
 * Les credentials servent à `docker login` sur chaque nœud + pull des images privées.
 * Le token n'est jamais réaffiché (write-only).
 */
export function IntegrationsPage() {
  const { t } = useTranslation()
  const { data: regs } = useQuery({ queryKey: ["registry"], queryFn: api.listRegistry })

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [registry, setRegistry] = useState("ghcr.io")
  const [username, setUsername] = useState("")
  const [token, setToken] = useState("")

  const trimmedRegistry = registry.trim()
  const trimmedUsername = username.trim()
  const trimmedToken = token.trim()

  const registryError = trimmedRegistry.length === 0 ? "Le registre est requis." : ""
  const usernameError = trimmedUsername.length === 0 ? "Le nom d’utilisateur est requis." : ""
  const tokenError = trimmedToken.length === 0 ? "Le token est requis." : ""

  const resetForm = () => {
    setRegistry("ghcr.io")
    setUsername("")
    setToken("")
  }

  const save = useMutationToast({
    mutationFn: () =>
      api.setRegistry({
        registry: trimmedRegistry || "ghcr.io",
        username: trimmedUsername,
        token: trimmedToken,
      }),
    success: t("integrations.toast.saveSuccess"),
    invalidate: [["registry"]],
    onSuccess: () => {
      resetForm()
      setDrawerOpen(false)
    },
  })

  const removeRegistry = useConfirmDelete<{ id: string; registry: string }>({
    mutationFn: (r) => api.deleteRegistry(r.id),
    success: t("integrations.toast.removeSuccess"),
    invalidate: [["registry"]],
    confirm: (r) => ({
      title: t("integrations.deleteConfirm.title"),
      description: t("integrations.deleteConfirm.description", { registry: r.registry }),
    }),
  })

  return (
    <PageContainer size="2xl">
      <PageHeader title={t("integrations.pageTitle")} />

      <div className="mb-4 flex justify-end">
        <Button onClick={() => setDrawerOpen(true)}>
          <Plus /> Ajouter un registre
        </Button>
      </div>

      <div className="mb-6">
        <ListContainer
          title={t("integrations.list.title")}
          subtitle={regs ? t("integrations.list.subtitle", { count: regs.length }) : undefined}
          isEmpty={regs?.length === 0}
          empty={
            <EmptyState
              icon={CircleStack}
              title={t("integrations.empty.title")}
              description={t("integrations.empty.description")}
            />
          }
        >
          {regs?.map((r) => (
            <ListRow key={r.id}>
              <div className="flex items-center gap-2">
                <CircleStack className="text-ui-fg-muted" />
                <Heading level="h3">{r.registry}</Heading>
                <Badge size="2xsmall">{r.username}</Badge>
              </div>
              <ActionMenu
                groups={[
                  {
                    actions: [
                      {
                        label: t("integrations.actions.delete"),
                        icon: <Trash />,
                        variant: "danger",
                        onClick: () => removeRegistry({ id: r.id, registry: r.registry }),
                      },
                    ],
                  },
                ]}
              />
            </ListRow>
          ))}
        </ListContainer>
      </div>

      <AppDrawer
        isOpen={drawerOpen}
        onClose={() => {
          setDrawerOpen(false)
          resetForm()
        }}
        title="Ajouter un registre"
        description="Renseignez le registre, l’identifiant et le token d’accès."
        onSave={() => save.mutate()}
        saveLabel={t("integrations.form.saveButton")}
        isLoading={save.isPending}
        saveDisabled={Boolean(registryError || usernameError || tokenError)}
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label size="small">{t("integrations.form.registryLabel")}</Label>
            <Input
              value={registry}
              onChange={(e) => setRegistry(e.target.value)}
              placeholder={t("integrations.form.registryPlaceholder")}
              aria-invalid={Boolean(registryError)}
            />
            <Text
              size="xsmall"
              className={registryError ? "mt-1 text-ui-fg-error" : "mt-1 text-ui-fg-muted"}
            >
              {registryError || t("integrations.form.registryHint")}
            </Text>
          </div>

          <div>
            <Label size="small">{t("integrations.form.userLabel")}</Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("integrations.form.userPlaceholder")}
              aria-invalid={Boolean(usernameError)}
            />
            {usernameError ? (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                {usernameError}
              </Text>
            ) : null}
          </div>

          <div>
            <Label size="small">{t("integrations.form.tokenLabel")}</Label>
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t("integrations.form.tokenPlaceholder")}
              aria-invalid={Boolean(tokenError)}
            />
            {tokenError ? (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                {tokenError}
              </Text>
            ) : null}
          </div>
        </div>
      </AppDrawer>
    </PageContainer>
  )
}