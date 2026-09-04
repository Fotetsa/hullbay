import type { ElementType } from "react"
import { Text } from "@medusajs/ui"
import type { TFunction } from "i18next"
import type { UpdateChannel } from "../../lib/api"

/** Labels de canal dépendants de la langue (via la fonction de traduction). */
export function channelLabels(t: TFunction): Record<UpdateChannel, { label: string; hint: string }> {
  return {
    stable: {
      label: t("updates.channel.stable.label"),
      hint: t("updates.channel.stable.hint"),
    },
    beta: {
      label: t("updates.channel.beta.label"),
      hint: t("updates.channel.beta.hint"),
    },
  }
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

/** Labels de statut d'une update, dépendants de la langue. */
export function statusLabels(
  t: TFunction,
): Record<string, { label: string; color?: StatusColor }> {
  return {
    success: { label: t("updates.status.success"), color: "green" },
    running: { label: t("updates.status.running"), color: "blue" },
    pending: { label: t("updates.status.pending"), color: "grey" },
    failed: { label: t("updates.status.failed"), color: "red" },
    rolled_back: { label: t("updates.status.rolled_back"), color: "orange" },
  }
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