import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Heading, Text } from "@medusajs/ui"
import { ArrowDownTray } from "@medusajs/icons"
import type { DatabaseConfig } from "@hullbay/shared"
import { api, type DatabaseNodePreview } from "../lib/api"

/**
 * Aperçu en lecture seule des ressources que le backend GÉNÉRERA pour un nœud
 * database (S5-09/10), via GET /api/projects/:id/nodes/:nodeId/preview.
 *
 * La config EN COURS d'édition (`config`, non sauvée) est envoyée en `draft` :
 * l'aperçu reflète le formulaire AVANT enregistrement. Debounce (~250ms) pour
 * ne pas assaillir l'API pendant la frappe — la prévisualisation est un coup
 * serveur pur, inutile d'en lancer un par keystroke.
 *
 * Info uniquement, cohérente avec le planificateur backend. On ne peut ni dériver
 * ni modifier ici ; le déploiement réel reste la seule source de vérité.
 */
const DRAFT_DEBOUNCE_MS = 250

export function DatabasePreviewPanel({
  projectId,
  nodeId,
  config,
}: {
  projectId: string
  nodeId: string
  config: Partial<DatabaseConfig>
}) {
  // Brouillon debouncé : la clé de query (et l'appel) ne change qu'après une
  // pause de frappe — pas à chaque caractère.
  const [debouncedConfig, setDebouncedConfig] = useState(config)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedConfig(config), DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [config])

  const draft = debouncedConfig
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["database-preview", projectId, nodeId, draft],
    queryFn: () => api.databaseNodePreview(projectId, nodeId, draft),
    refetchOnMount: "always",
    retry: 1,
    placeholderData: (prev) => prev,
  })

  const download = () => {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `database-${nodeId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const copy = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    } catch {
      // presse-papiers indisponible (permission, http non-secu) → silencieux
    }
  }

  if (isLoading) {
    return <Text size="xsmall" className="text-ui-fg-muted">Calcul de l'aperçu…</Text>
  }

  if (error) {
    return (
      <div className="flex flex-col gap-2">
        <Text size="xsmall" className="text-ui-fg-error">
          Aperçu indisponible : {(error as Error).message}
        </Text>
        <Button size="small" variant="secondary" onClick={() => refetch()}>
          Réessayer
        </Button>
      </div>
    )
  }

  if (!data) {
    return <Text size="xsmall" className="text-ui-fg-muted">Aperçu vide.</Text>
  }

  if (data.missingPasswordSecret) {
    return (
      <Text size="xsmall" className="text-ui-fg-muted">
        Sélectionne le secret Docker du mot de passe (Identifiants) pour afficher
        l'aperçu des ressources générées.
      </Text>
    )
  }

  return <DatabasePreviewView data={data} onCopy={copy} onDownload={download} />
}

export function DatabasePreviewView({
  data,
  onCopy,
  onDownload,
}: {
  data: DatabaseNodePreview
  onCopy: () => void
  onDownload: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Heading level="h3" className="txt-compact-small">
          Ressources générées ({data.resources.length})
        </Heading>
        <div className="flex gap-1">
          <Button size="small" variant="transparent" onClick={onCopy}>
            Copier
          </Button>
          <Button size="small" variant="transparent" onClick={onDownload}>
            <ArrowDownTray /> JSON
          </Button>
        </div>
      </div>

      <ul className="flex flex-col gap-1.5">
        {data.resources.map((r) => (
          <li
            key={`${r.kind}:${r.name}`}
            className="flex items-center justify-between rounded-md border border-ui-border-base px-2.5 py-1.5"
          >
            <span className="txt-compact-xsmall text-ui-fg-muted capitalize">{r.kind}</span>
            <span className="txt-compact-xsmall text-ui-fg-base font-mono">{r.name}</span>
            <span className="txt-compact-xsmall text-ui-fg-subtle">{r.role}</span>
          </li>
        ))}
      </ul>

      <Heading level="h3" className="txt-compact-small">
        Connexions applicatives ({data.connections.length})
      </Heading>
      <ul className="flex flex-col gap-1.5">
        {data.connections.map((c) => (
          <li
            key={`${c.role}:${c.host}:${c.port}`}
            className="flex flex-col gap-0.5 rounded-md border border-ui-border-base px-2.5 py-1.5"
          >
            <span className="txt-compact-xsmall text-ui-fg-base">
              {c.role === "writer" ? "Écriture" : "Lecture"} — {c.host}:{c.port}
            </span>
            <span className="txt-compact-xsmall text-ui-fg-muted font-mono">
              DB={c.database} · user={c.username} · mot de passe = {c.passwordSecretRef}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}