import type { ReactNode } from "react"
import { Container, Heading, Text } from "@medusajs/ui"

/**
 * Conteneur de liste façon admin-panel : `Container divide-y p-0` avec un header
 * (titre + sous-titre + actions) à `px-6 py-4` et des lignes structurées. Homogénéise
 * le placement du contenu sur toutes les pages de liste.
 */
export function ListContainer({
  title,
  subtitle,
  actions,
  children,
  empty,
  isEmpty,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  /** Message affiché quand la liste est vide. */
  empty?: ReactNode
  isEmpty?: boolean
}) {
  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Heading level="h2">{title}</Heading>
          {subtitle && (
            <Text size="small" className="text-ui-fg-subtle">
              {subtitle}
            </Text>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {isEmpty ? (
        <div className="px-6 py-8">
          {empty}
        </div>
      ) : (
        children
      )}
    </Container>
  )
}

/** Une ligne de liste standard : padding cohérent + alignement. */
export function ListRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-6 py-4">{children}</div>
  )
}
