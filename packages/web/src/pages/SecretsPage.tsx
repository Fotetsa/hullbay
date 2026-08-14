import { useState } from "react"
import { useParams } from "react-router-dom" // <-- Ajout pour récupérer l'ID dans l'URL
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text, Badge } from "@medusajs/ui"
import { Plus, Trash, Key } from "@medusajs/icons"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ListContainer, ListRow } from "../components/ListContainer"
import { ActionMenu } from "../components/ActionMenu"
import { EmptyState } from "../components/EmptyState"
import { useTranslation } from "react-i18next"

/**
 * Gestion des Docker Secrets : valeurs sensibles stockées HORS labels/env.
 * La valeur est write-only (jamais réaffichée). Référencée par nom dans la config
 * d'un conteneur (montée en /run/secrets/<nom>). Swarm la chiffre au repos.
 */
export function SecretsPage() {
  const { t } = useTranslation()
  
  // 1. Récupération du clusterId depuis l'URL
  const { clusterId } = useParams<{ clusterId: string }>()

  // 2. Ajout du clusterId dans la queryKey et la queryFn
  const { data: secrets } = useQuery({ 
    queryKey: ["secrets", clusterId], 
    queryFn: () => api.listSecrets(clusterId!) 
  })

  const [name, setName] = useState("")
  const [value, setValue] = useState("")

  const save = useMutationToast({
    // 3. Ajout du clusterId pour la création
    mutationFn: () => api.setSecret(clusterId!, { name, value }),
    success: t('secrets.toast.saveSuccess'),
    invalidate: [["secrets", clusterId]], // Invalidation ciblée
    onSuccess: () => {
      setName("")
      setValue("")
    },
  })

  const removeSecret = useConfirmDelete<string>({
    // 4. Ajout du clusterId pour la suppression
    mutationFn: (n) => api.deleteSecret(clusterId!, n),
    success: t('secrets.toast.removeSuccess'),
    invalidate: [["secrets", clusterId]], // Invalidation ciblée
    confirm: (n) => ({
      title: t('secrets.deleteConfirm.title'),
      description: t('secrets.deleteConfirm.description', { name: n }),
    }),
  })

  return (
    <PageContainer size="2xl">
      <PageHeader title={t('secrets.pageTitle')} />

      <div className="mb-6">
        <ListContainer
          title={t('secrets.list.title')}
          subtitle={secrets ? t('secrets.list.subtitle', { count: secrets.length }) : undefined}
          isEmpty={secrets?.length === 0}
          empty={
            <EmptyState
              icon={Key}
              title={t('secrets.empty.title')}
              description={t('secrets.empty.description')}
            />
          }
        >
          {secrets?.map((s) => (
            <ListRow key={s.id}>
              <div className="flex items-center gap-2">
                <Key className="text-ui-fg-muted" />
                <Heading level="h3">{s.name}</Heading>
                <Badge size="2xsmall" color="green">
                  {t('secrets.badge.encrypted')}
                </Badge>
              </div>
              <ActionMenu
                groups={[
                  {
                    actions: [
                      {
                        label: t('secrets.actions.delete'),
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
          {t('secrets.form.title')}
        </Heading>
        <div className="flex flex-col gap-3">
          <div>
            <Label size="small">{t('secrets.form.nameLabel')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('secrets.form.namePlaceholder')}
            />
            <Text size="xsmall" className="mt-1 text-ui-fg-muted">
              {t('secrets.form.nameHint')}
            </Text>
          </div>
          <div>
            <Label size="small">{t('secrets.form.valueLabel')}</Label>
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('secrets.form.valuePlaceholder')}
            />
          </div>
          <Button
            onClick={() => save.mutate()}
            isLoading={save.isPending}
            disabled={!name.trim() || !value}
          >
            <Plus /> {t('secrets.form.saveButton')}
          </Button>
        </div>
      </Container>
    </PageContainer>
  )
}