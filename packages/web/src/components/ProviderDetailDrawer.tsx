import { Badge, Button, Drawer, Heading, Text } from "@medusajs/ui"
import { Beaker, PencilSquare, Trash } from "@medusajs/icons"
import type { TFunction } from "i18next"
import { ToggleSwitch } from "./ToggleSwitch"
import { SECRET_MASK, type AuthProviderAdmin } from "../lib/api"

type ProviderActions = {
  onClose: () => void
  onToggle: () => void
  onEdit: () => void
  onTest: () => void
  onDelete: () => void
}

function configValueLabel(t: TFunction, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—"
  if (value === SECRET_MASK) return t("providers.detail.masked")
  if (Array.isArray(value)) return value.join(", ")
  return String(value)
}

/**
 * Détail read-only d'un provider (pattern « liaison database ») : ouverture
 * latérale, valeurs masquées pour les champs sensibles, actions groupées.
 */
export function ProviderDetailDrawer({
  open,
  provider,
  isLastActive,
  testing,
  actions,
  t,
}: {
  open: boolean
  provider: AuthProviderAdmin | null
  isLastActive: boolean
  testing: boolean
  actions: ProviderActions
  t: TFunction
}) {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && actions.onClose()}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>{t("providers.detail.title")}</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-col gap-5 overflow-y-auto">
          {provider ? (
            <>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Heading level="h2" className="truncate">
                    {provider.name}
                  </Heading>
                  <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                    {provider.id}
                  </Text>
                </div>
                <Badge size="2xsmall" color={provider.enabled ? "green" : "grey"}>
                  {provider.enabled ? t("providers.badge.enabled") : t("providers.badge.disabled")}
                </Badge>
              </div>

              <div>
                <Text size="small" weight="plus" className="mb-2 text-ui-fg-base">
                  {t("providers.detail.configTitle")}
                </Text>
                <div className="divide-y divide-ui-border-base overflow-hidden rounded-lg border border-ui-border-base bg-ui-bg-base">
                  {(Object.keys(provider.config ?? {}).length ? Object.keys(provider.config) : ["—"]).map(
                    (key) => (
                      <div key={key} className="flex items-start justify-between gap-3 px-4 py-2.5">
                        <Text size="small" className="text-ui-fg-muted">
                          {key}
                        </Text>
                        <Text
                          size="small"
                          className={`max-w-[60%] break-all text-right ${
                            provider.config[key] === SECRET_MASK ? "tracking-widest" : "text-ui-fg-base"
                          }`}
                        >
                          {configValueLabel(t, provider.config[key])}
                        </Text>
                      </div>
                    ),
                  )}
                </div>
                {!Object.keys(provider.config ?? {}).length && (
                  <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                    {t("providers.detail.noConfig")}
                  </Text>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-ui-border-base pt-4">
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    checked={provider.enabled}
                    disabled={isLastActive}
                    onCheckedChange={actions.onToggle}
                    aria-label={t("providers.form.enabledLabel")}
                  />
                  <Text size="small" className="text-ui-fg-muted">
                    {t("providers.form.enabledLabel")}
                  </Text>
                </div>
                <div className="flex-1" />
                <Button
                  variant="secondary"
                  size="small"
                  disabled={testing}
                  isLoading={testing}
                  onClick={actions.onTest}
                >
                  <Beaker /> {t("providers.actions.test")}
                </Button>
                <Button variant="secondary" size="small" onClick={actions.onEdit}>
                  <PencilSquare /> {t("providers.actions.edit")}
                </Button>
                {provider.id !== "local" && (
                  <Button variant="danger" size="small" onClick={actions.onDelete}>
                    <Trash /> {t("providers.actions.delete")}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <Text className="text-ui-fg-subtle">{t("providers.detail.noSelection")}</Text>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer>
  )
}