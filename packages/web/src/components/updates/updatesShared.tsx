import type { ElementType } from "react"
import { Text } from "@medusajs/ui"
import type { UpdateChannel } from "../../lib/api"

export const CHANNEL_LABELS: Record<UpdateChannel, { label: string; hint: string }> = {
  stable: { label: "Stable", hint: "Versions testées, recommandé en production." },
  beta: { label: "Beta", hint: "Versions en pré-publication, peut contenir des régressions." },
}

export type StatusColor = "green" | "red" | "orange" | "blue" | "grey"

export type ReleaseType = "stable" | "beta" | "rc"

/**
 * Type de release : stable (prerelease: false) ; sinon RC si le tag porte un
 * préfixe `-rc`, beta sinon (alpha/autres pré-releases → beta).
 */
export function releaseType(r: { prerelease: boolean; version: string }): ReleaseType {
  if (!r.prerelease) return "stable"
  return /-(?:rc)\b/i.test(r.version) ? "rc" : "beta"
}

export const STATUS_LABELS: Record<string, { label: string; color?: StatusColor }> = {
  success: { label: "Réussi", color: "green" },
  running: { label: "En cours", color: "blue" },
  pending: { label: "En attente", color: "grey" },
  failed: { label: "Échec", color: "red" },
  rolled_back: { label: "Annulé", color: "orange" },
}

/** Empty state de carte : grande icône dans un disque, titre + sous-texte. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: ElementType
  title: string
  hint?: string
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-14 text-center">
      <div className="flex h-24 w-24 items-center justify-center rounded-full bg-ui-bg-subtle">
        <Icon className="h-12 w-12 text-ui-fg-muted" aria-hidden />
      </div>
      <div className="flex flex-col gap-1">
        <Text weight="plus" className="text-ui-fg-base">{title}</Text>
        {hint && <Text size="small" className="text-ui-fg-muted">{hint}</Text>}
      </div>
    </div>
  )
}