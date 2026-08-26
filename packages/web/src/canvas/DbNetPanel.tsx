import { useEffect, useRef } from "react"
import { Trash, XMark } from "@medusajs/icons"
import { Button, Heading, Label, Text, usePrompt } from "@medusajs/ui"

/** Une liaison conteneur→base : l'edge persisté + le nom du conteneur. */
export type DbNetLinkRow = {
  edgeId: string
  containerName: string
}

/**
 * Données du panneau lecture seule d'une base reliée : la base peut être
 * connectée à PLUSIEURS conteneurs (autant d'edges kind="database"), le panneau
 * liste donc TOUTES ses liaisons, chacune supprimable indépendamment.
 * Dérivé du seul graphe persisté — le rendu canvas n'est qu'une vue.
 */
export type DbNetInfoData = {
  /** Nom de la base parente (ex: "catalog"). */
  dbName: string
  /** Nom Docker réel du réseau généré au déploiement (ex: "boz_mon-projet_catalog-net"). */
  overlayName: string
  engine: string
  mode: string
  /** Toutes les liaisons conteneur→base existantes pour CETTE base. */
  links: DbNetLinkRow[]
}

/**
 * Panneau ouvert au clic sur une ligne pointillée de liaison conteneur↔base :
 * lecture seule pour le RÉSEAU généré (non éditable/supprimable directement) ;
 * il liste TOUTES les liaisons de la base — chacune supprimable, car rompre
 * l'edge persisté est LE moyen officiel de retirer ce réseau.
 */
export function DbNetInfoPanel({
  data,
  onClose,
  onDeleteLink,
}: {
  data: DbNetInfoData
  onClose: () => void
  /** Supprime l'edge persisté kind="database" correspondant à la ligne. */
  onDeleteLink: (edgeId: string) => Promise<void>
}) {
  const prompt = usePrompt()

  // Focus initial : sans focus dans le panneau, le raccourci Escape est mort.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  async function removeLink(link: DbNetLinkRow) {
    const ok = await prompt({
      title: "Supprimer cette liaison ?",
      description: `« ${link.containerName} » ne sera plus relié à « ${data.dbName} ». Redéploie pour appliquer le changement à Docker.`,
      confirmText: "Supprimer",
      cancelText: "Annuler",
      variant: "danger",
    })
    if (!ok) return
    await onDeleteLink(link.edgeId)
  }

  const shortName = `${data.dbName}-net`

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="absolute right-4 top-4 z-10 w-[320px] overflow-hidden rounded-xl border border-ui-border-base bg-ui-bg-base shadow-elevation-flyout outline-none"
      role="dialog"
      aria-label={`Réseau généré ${shortName}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
    >
      <div className="flex items-center justify-between border-b border-ui-border-base px-4 py-3">
        <Heading level="h3">Réseau généré</Heading>
        <Button variant="transparent" size="small" onClick={onClose} aria-label="Fermer">
          <XMark />
        </Button>
      </div>
      <div className="space-y-3 p-4">
        <div>
          <Label size="small">Nom affiché</Label>
          <Text size="small">{shortName}</Text>
        </div>
        <div>
          <Label size="small">Ressource Docker réelle</Label>
          <Text size="small" className="font-mono">
            {data.overlayName}
          </Text>
        </div>
        <div>
          <Label size="small">Base attachée</Label>
          <Text size="small">
            {data.dbName} · {data.engine} · {data.mode}
          </Text>
        </div>
        <div>
          <Label size="small">
            Liaisons ({data.links.length} conteneur{data.links.length > 1 ? "s" : ""})
          </Label>
          <ul className="mt-1 space-y-1">
            {data.links.map((link) => (
              <li key={link.edgeId} className="flex items-center justify-between gap-2">
                <Text size="small" className="truncate">
                  {link.containerName}
                </Text>
                <Button
                  variant="transparent"
                  size="small"
                  className="text-ui-fg-error"
                  aria-label={`Supprimer la liaison avec ${link.containerName}`}
                  onClick={() => removeLink(link)}
                >
                  <Trash />
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <Text size="xsmall" className="block text-ui-fg-muted">
          Ce réseau est créé automatiquement par les liens « base de données ».
          Il n'est ni modifiable ni supprimable directement : rompez les
          liaisons ci-dessus puis redéployez pour le retirer.
        </Text>
      </div>
    </div>
  )
}
