import { useEffect, useState } from "react"
import { Button, Heading, Input, Label, Switch, Text, toast } from "@medusajs/ui"
import { Trash, XMark } from "@medusajs/icons"
import type { Edge } from "@hullbay
import { api } from "../lib/api"
import { useConfirmDelete } from "../lib/useConfirmDelete"

/**
 * Inspecteur d'edge (panneau latéral droit) : édite la config d'un lien
 * container<->volume (mountPath/readOnly). Les liens network/gateway n'ont pas
 * de config additionnelle (le kind seul pilote le déploiement).
 */
export function EdgeInspector({
  edge,
  onClose,
  onSaved,
  onDeleted,
}: {
  edge: Edge
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [mountPath, setMountPath] = useState((edge.config?.mountPath as string) ?? "")
  const [readOnly, setReadOnly] = useState(Boolean(edge.config?.readOnly))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setMountPath((edge.config?.mountPath as string) ?? "")
    setReadOnly(Boolean(edge.config?.readOnly))
  }, [edge.id])

  const remove = useConfirmDelete<Edge>({
    mutationFn: (e) => api.deleteEdge(e.id),
    success: "Lien supprimé",
    confirm: () => ({
      title: "Supprimer ce lien ?",
      description: "Le lien sera retiré du projet. Redéploie pour appliquer le changement à Docker.",
      confirmText: "Supprimer",
      cancelText: "Annuler",
    }),
    onSuccess: onDeleted,
  })

  async function save() {
    setSaving(true)
    try {
      await api.updateEdge(edge.id, { config: { mountPath: mountPath || undefined, readOnly } })
      toast.success("Lien enregistré")
      onSaved()
    } catch (e) {
      toast.error("Erreur", { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="absolute right-4 top-4 bottom-4 z-10 flex w-[360px] flex-col overflow-hidden rounded-xl border border-ui-border-base bg-ui-bg-base shadow-elevation-flyout"
      role="dialog"
      aria-label={`Configuration du lien ${edge.kind}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
    >
      <div className="flex items-center justify-between border-b border-ui-border-base px-4 py-3">
        <Heading level="h3" className="capitalize">
          Lien {edge.kind}
        </Heading>
        <Button variant="transparent" size="small" onClick={onClose} aria-label="Fermer l'inspecteur">
          <XMark />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {edge.kind === "volume" ? (
          <div className="flex flex-col gap-4">
            <div>
              <Label size="small">Chemin de montage</Label>
              <Input
                value={mountPath}
                onChange={(e) => setMountPath(e.target.value)}
                placeholder="/data/mon-volume (défaut si vide)"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label size="small">Lecture seule</Label>
              <Switch checked={readOnly} onCheckedChange={setReadOnly} />
            </div>
          </div>
        ) : (
          <Text size="small" className="text-ui-fg-muted">
            Pas de configuration additionnelle pour un lien {edge.kind}.
          </Text>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ui-border-base p-4">
        <Button variant="danger" onClick={() => remove(edge)}>
          <Trash /> Supprimer
        </Button>
        {edge.kind === "volume" && (
          <Button onClick={save} isLoading={saving}>
            Enregistrer
          </Button>
        )}
      </div>
    </div>
  )
}
