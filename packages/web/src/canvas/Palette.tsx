import { Text } from "@medusajs/ui"
import type { NodeType } from "@hullbay
import { NODE_META } from "./node-meta"

/**
 * Palette FLOTTANTE (overlay en haut à gauche du canvas) : les types de nœuds
 * qu'on ajoute au canvas.
 *
 * Deux voies d'ajout, par accessibilité :
 *  - DRAG (souris) : transporte le type via dataTransfer, drop à la position.
 *  - CLIC / CLAVIER (Enter/Space) : `onAdd` crée le nœud au centre du canvas.
 * Le drag HTML5 seul est inutilisable au clavier ; le fallback est obligatoire.
 */
const TYPES: NodeType[] = ["container", "network", "volume", "gateway"]

export function Palette({ onAdd }: { onAdd: (type: NodeType) => void }) {
  return (
    <div
      className="absolute left-4 top-4 z-10 flex w-[200px] flex-col gap-2 rounded-xl border border-ui-border-base bg-ui-bg-base/95 p-3 shadow-elevation-flyout backdrop-blur"
      role="toolbar"
      aria-label="Composants à ajouter au canvas"
    >
      <Text size="xsmall" weight="plus" className="mb-1 uppercase text-ui-fg-muted">
        Composants
      </Text>
      {TYPES.map((type) => {
        const { label, hint, Icon } = NODE_META[type]
        return (
          <div
            key={type}
            role="button"
            tabIndex={0}
            aria-label={`Ajouter ${label} : ${hint}`}
            draggable
            onClick={() => onAdd(type)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onAdd(type)
              }
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/bozando-node-type", type)
              // MIME dédié par type : lisible via `dataTransfer.types` PENDANT le
              // drag (dragover/dragenter), contrairement à `getData` qui est bloqué
              // par les navigateurs jusqu'au drop. Sert au highlight des conteneurs
              // valides dès le début du drag d'un volume (OpsNode.tsx).
              e.dataTransfer.setData(`application/bozando-node-type-${type}`, type)
              e.dataTransfer.effectAllowed = "move"
            }}
            className="flex cursor-grab items-center gap-2 rounded-lg border border-ui-border-base bg-ui-bg-subtle px-3 py-2 hover:border-ui-border-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-border-interactive active:cursor-grabbing"
          >
            <Icon />
            <div>
              <div className="txt-compact-small-plus text-ui-fg-base">{label}</div>
              <div className="txt-compact-xsmall text-ui-fg-muted">{hint}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
