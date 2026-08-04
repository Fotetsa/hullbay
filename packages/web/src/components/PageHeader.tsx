import { useEffect, type ReactNode } from "react"
import { Heading, Text } from "@medusajs/ui"

/**
 * En-tête de page réutilisable : titre (+ sous-titre optionnel) à gauche, slot
 * d'actions à droite. Remplace le bloc header dupliqué dans chaque page. La
 * navigation "retour" est désormais assurée par la sidebar (AppLayout), donc
 * plus de flèche ArrowLeft ici.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  // Titre d'onglet par page (les onglets étaient indistinguables sinon).
  useEffect(() => {
    document.title = `${title} · hullbay`
  }, [title])

  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div>
        <Heading level="h1">{title}</Heading>
        {subtitle && (
          <Text size="small" className="mt-1 text-ui-fg-subtle">
            {subtitle}
          </Text>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
      )}
    </div>
  )
}

/**
 * Conteneur de page standard : padding + largeur max centrée. Mutualise le
 * `min-h-full ... p-8` + `mx-auto max-w-Xxl` répété dans chaque page.
 */
export function PageContainer({
  children,
  size = "4xl",
}: {
  children: ReactNode
  size?: "2xl" | "4xl" | "5xl"
}) {
  const maxW = { "2xl": "max-w-2xl", "4xl": "max-w-4xl", "5xl": "max-w-5xl" }[size]
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className={`mx-auto ${maxW}`}>{children}</div>
    </div>
  )
}
