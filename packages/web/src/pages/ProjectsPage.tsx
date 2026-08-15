import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  FocusModal,
  Textarea,
  Select,
} from "@medusajs/ui"
import { Plus, ArrowPath, PencilSquare, Trash, SquaresPlus } from "@medusajs/icons"
import type { Project } from "@hullbay/shared"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ActionMenu } from "../components/ActionMenu"
import { EmptyState } from "../components/EmptyState"
import { ModalForm } from "../components/ModalForm"
import { useTranslation } from "react-i18next"

export function ProjectsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: api.listProjects,
  })
  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.listClusters})

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [clusterId, setClusterId] = useState("")

  // Édition (rename) : on garde le projet en cours d'édition + ses champs.
  const [editing, setEditing] = useState<Project | null>(null)
  const [editName, setEditName] = useState("")
  const [editDescription, setEditDescription] = useState("")

  const createMut = useMutationToast({
    // Utilisation de la version avec clusterId et de la traduction
    mutationFn: () => api.createProject({ name, description: description || undefined, clusterId }),
    success: t('projects.toast.createSuccess'),
    invalidate: [["projects"]],
    onSuccess: () => {
      setCreateOpen(false)
      setName("")
      setDescription("")
      setClusterId("")
    },
  })

  const updateMut = useMutationToast({
    mutationFn: () =>
      api.updateProject(editing!.id, {
        name: editName,
        description: editDescription || undefined,
      }),
    success: t('projects.toast.updateSuccess'),
    invalidate: [["projects"]],
    onSuccess: () => setEditing(null),
  })

  const rebuildMut = useMutationToast({
    mutationFn: api.rebuild,
    success: (r) => t('projects.toast.rebuildSuccess', { projects: r.projects, nodes: r.nodes }),
    invalidate: [["projects"]],
  })

  const removeProject = useConfirmDelete<Project>({
    mutationFn: (p) => api.deleteProject(p.id),
    success: t('projects.toast.deleteSuccess'),
    invalidate: [["projects"]],
    confirm: (p) => ({
      title: t('projects.deleteConfirm.title'),
      description: t('projects.deleteConfirm.description', { name: p.name }),
    }),
  })

  function openEdit(p: Project) {
    setEditing(p)
    setEditName(p.name)
    setEditDescription(p.description ?? "")
  }

  //Si un cluster est disponible alors on le pré-selectionne par defaut au moment de l'ouverture
  function openCreate() {
    const def = clusters?.find((c) => c.isDefault)
    setClusterId(def?.id ?? clusters?.[0]?.id ?? "")
    setCreateOpen(true)
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('projects.pageTitle')}
        actions={
          <>
            <Button
              variant="secondary"
              size="small"
              onClick={() => rebuildMut.mutate()}
              isLoading={rebuildMut.isPending}
            >
              <ArrowPath /> {t('projects.actions.rebuild')}
            </Button>
            <Button size="small" onClick={() => openCreate()}>
              <Plus /> {t('projects.actions.new')}
            </Button>
          </>
        }
      />

      {isLoading ? (
        <Text>{t('projects.loading')}</Text>
      ) : projects?.length === 0 ? (
        <Container className="p-0">
          <EmptyState
            icon={SquaresPlus}
            title={t('projects.empty.title')}
            description={t('projects.empty.description')}
            action={
              <Button size="small" onClick={() => openCreate()}>
                <Plus /> {t('projects.actions.new')}
              </Button>
            }
          />
        </Container>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projects?.map((p) => (
            <Container
              key={p.id}
              className="flex items-start justify-between gap-2 p-4 transition-shadow hover:shadow-elevation-card-hover"
            >
              <button
                type="button"
                className="flex-1 text-left"
                onClick={() => navigate(`/canvas/${p.id}`)}
              >
                <Heading level="h3">{p.name}</Heading>
                <Text className="text-ui-fg-subtle" size="small">
                  {p.slug} · {p.status}
                </Text>
              </button>
              <ActionMenu
                groups={[
                  {
                    actions: [
                      {
                        label: t('projects.actions.rename'),
                        icon: <PencilSquare />,
                        onClick: () => openEdit(p),
                      },
                    ],
                  },
                  {
                    actions: [
                      {
                        label: t('projects.actions.delete'),
                        icon: <Trash />,
                        variant: "danger",
                        onClick: () => removeProject(p),
                      },
                    ],
                  },
                ]}
              />
            </Container>
          ))}
        </div>
      )}

      {/* Création */}
      <FocusModal open={createOpen} onOpenChange={setCreateOpen}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading>{t('projects.createModal.title')}</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm onSubmit={() => name.trim() && createMut.mutate()}>
              <div>
                <Label size="small">{t('projects.createModal.nameLabel')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('projects.createModal.namePlaceholder')}
                  autoFocus
                />
              </div>
              <div>
                <Label size="small">{t('projects.createModal.descLabel')}</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('projects.createModal.descPlaceholder')}
                />
              </div>

              {/** Selection du cluster */}
              <div>
                <Label size="small">Cluster</Label>
                <Select value={clusterId} onValueChange={setClusterId}>
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
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="secondary" type="button" onClick={() => setCreateOpen(false)}>
                  {t('projects.actions.cancel')}
                </Button>
                <Button
                  type="submit"
                  isLoading={createMut.isPending}
                  disabled={!name.trim() || !clusterId}
                >
                  {t('projects.actions.create')}
                </Button>
              </div>
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>

      {/* Édition (rename) */}
      <FocusModal open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <FocusModal.Content>
          <FocusModal.Header>
            <Heading>{t('projects.editModal.title')}</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm onSubmit={() => editName.trim() && updateMut.mutate()}>
              <div>
                <Label size="small">{t('projects.editModal.nameLabel')}</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus />
                <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                  {t('projects.editModal.slugHint')}
                </Text>
              </div>
              <div>
                <Label size="small">{t('projects.editModal.descLabel')}</Label>
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="secondary" type="button" onClick={() => setEditing(null)}>
                  {t('projects.actions.cancel')}
                </Button>
                <Button type="submit" isLoading={updateMut.isPending} disabled={!editName.trim()}>
                  {t('projects.actions.save')}
                </Button>
              </div>
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </PageContainer>
  )
}