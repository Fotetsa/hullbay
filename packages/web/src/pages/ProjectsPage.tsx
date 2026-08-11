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

export function ProjectsPage() {
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
    mutationFn: () => api.createProject({ name, description: description || undefined, clusterId }),
    success: "Projet créé",
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
    success: "Projet mis à jour",
    invalidate: [["projects"]],
    onSuccess: () => setEditing(null),
  })

  const rebuildMut = useMutationToast({
    mutationFn: api.rebuild,
    success: (r) => `Reconstruit : ${r.projects} projets, ${r.nodes} nœuds`,
    invalidate: [["projects"]],
  })

  const removeProject = useConfirmDelete<Project>({
    mutationFn: (p) => api.deleteProject(p.id),
    success: "Projet supprimé",
    invalidate: [["projects"]],
    confirm: (p) => ({
      title: "Supprimer le projet ?",
      description: `« ${p.name} » et tous ses nœuds/liens seront supprimés du désiré. Les ressources Docker déjà déployées doivent être détruites séparément depuis le canvas.`,
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
        title="Projets"
        actions={
          <>
            <Button
              variant="secondary"
              size="small"
              onClick={() => rebuildMut.mutate()}
              isLoading={rebuildMut.isPending}
            >
              <ArrowPath /> Reconstruire depuis Docker
            </Button>
            <Button size="small" onClick={() => setCreateOpen(true)}>
              <Plus /> Nouveau projet
            </Button>
          </>
        }
      />

      {isLoading ? (
        <Text>Chargement…</Text>
      ) : projects?.length === 0 ? (
        <Container className="p-0">
          <EmptyState
            icon={SquaresPlus}
            title="Aucun projet"
            description="Crée un projet, puis dessine son architecture sur le canvas (conteneurs, réseaux, volumes, passerelles)."
            action={
              <Button size="small" onClick={() => setCreateOpen(true)}>
                <Plus /> Nouveau projet
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
                        label: "Renommer",
                        icon: <PencilSquare />,
                        onClick: () => openEdit(p),
                      },
                    ],
                  },
                  {
                    actions: [
                      {
                        label: "Supprimer",
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
            <Heading>Nouveau projet</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm onSubmit={() => name.trim() && createMut.mutate()}>
              <div>
                <Label size="small">Nom</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Boutique Bozando Prod"
                  autoFocus
                />
              </div>
              <div>
                <Label size="small">Description</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="À quoi sert ce projet ?"
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
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setCreateOpen(false)}
                >
                  Annuler
                </Button>
                <Button
                  type="submit"
                  isLoading={createMut.isPending}
                  disabled={!name.trim() || !clusterId}
                >
                  Créer
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
            <Heading>Renommer le projet</Heading>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            <ModalForm onSubmit={() => editName.trim() && updateMut.mutate()}>
              <div>
                <Label size="small">Nom</Label>
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  autoFocus
                />
                <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                  Le slug technique (préfixe des ressources Docker) ne change
                  pas.
                </Text>
              </div>
              <div>
                <Label size="small">Description</Label>
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Annuler
                </Button>
                <Button
                  type="submit"
                  isLoading={updateMut.isPending}
                  disabled={!editName.trim()}
                >
                  Enregistrer
                </Button>
              </div>
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </PageContainer>
  );
}
