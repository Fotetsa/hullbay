import { Badge, Button, Container, DropdownMenu, Heading, IconButton, Text, clx } from "@medusajs/ui"
import { ArrowPath, ArrowUpRightMini, Check, Funnel, History } from "@medusajs/icons"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import type { SystemUpdateRecord } from "../../lib/api"
import { EmptyState, statusLabels } from "./updatesShared"

const STATUS_FILTERS: { value: string; labelKey: string }[] = [
  { value: "all", labelKey: "updates.history.filter.all" },
  { value: "success", labelKey: "updates.history.filter.success" },
  { value: "failed", labelKey: "updates.history.filter.failed" },
  { value: "rolled_back", labelKey: "updates.history.filter.rolledBack" },
  { value: "running", labelKey: "updates.history.filter.running" },
]

type HistoryGroup =
  | { kind: "source"; update: SystemUpdateRecord; rollbacks: SystemUpdateRecord[] }
  | { kind: "orphan"; update: SystemUpdateRecord }

/**
 * Regroupe chaque rollback sous son update source (rollbackOfId) quand la
 * source est présente dans la page courante. Les rollbacks orphelins (source
 * hors page, ex. pagination ou filtre statut) restent affichés seuls. Ordre
 * d'affichage : celui de l'API (createdAt desc) ; les rollbacks d'une même
 * source sont triés par date croissante (tentatives avortées → rollback final).
 */
function groupHistory(items: SystemUpdateRecord[]): HistoryGroup[] {
  const sourceIds = new Set(items.filter((h) => !h.rollbackOfId).map((h) => h.id))
  const bySource = new Map<string, SystemUpdateRecord[]>()
  for (const h of items) {
    if (!h.rollbackOfId || !sourceIds.has(h.rollbackOfId)) continue
    const arr = bySource.get(h.rollbackOfId) ?? []
    arr.push(h)
    bySource.set(h.rollbackOfId, arr)
  }
  const groups: HistoryGroup[] = []
  for (const h of items) {
    // Le rollback est rendu sous sa source (déjà présente dans la page).
    if (h.rollbackOfId && sourceIds.has(h.rollbackOfId)) continue
    if (h.rollbackOfId) {
      groups.push({ kind: "orphan", update: h })
    } else {
      const rollbacks = (bySource.get(h.id) ?? []).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
      groups.push({ kind: "source", update: h, rollbacks })
    }
  }
  return groups
}

/**
 * Carte d'une entrée d'historique : action (Mise à jour / Rollback), statut,
 * versions début/fin et dates début/fin. Les détails techniques (étapes, logs,
 * erreur) sont masqués pour l'instant. Le bouton Rollback n'existe que sur une
 * update réussie non encore annulée.
 */
function HistoryCard({
  update,
  action,
  highlighted,
  onRollback,
  rollbackPending,
  rollbackLoading,
  disabled,
  t,
}: {
  update: SystemUpdateRecord
  action: "update" | "rollback"
  highlighted?: boolean
  onRollback?: () => void
  rollbackPending?: boolean
  rollbackLoading?: boolean
  disabled?: boolean
  t: TFunction
}) {
  const status = statusLabels(t)[update.status] ?? { label: update.status }
  const ActionIcon = action === "rollback" ? ArrowPath : ArrowUpRightMini
  const startDate = update.startedAt ?? update.createdAt

  return (
    <div
      data-testid="history-entry"
      className={clx(
        "flex flex-col gap-2 rounded-md border bg-ui-bg-base p-3",
        action === "rollback"
          ? "ml-5 border-ui-border-base/60"
          : "border-ui-border-base",
        highlighted && "border-ui-border-interactive",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge size="small" color={action === "rollback" ? "orange" : "blue"}>
          <span className="inline-flex items-center gap-1">
            <ActionIcon className="h-3 w-3" aria-hidden />
            {action === "rollback"
              ? t("updates.history.card.rollback")
              : t("updates.history.card.update")}
          </span>
        </Badge>
        <Badge size="small" color={status.color}>{status.label}</Badge>
        {action === "update" && update.status === "success" && !update.rolledBack && (
          <Button
            variant={rollbackPending ? "danger" : "secondary"}
            size="small"
            className="ml-auto"
            disabled={disabled}
            isLoading={rollbackLoading}
            onClick={onRollback}
          >
            {rollbackPending
              ? t("updates.history.card.confirmRollback")
              : t("updates.history.card.rollback")}
          </Button>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex items-baseline gap-2">
          <dt className="text-ui-fg-muted">{t("updates.history.card.versionFrom")}</dt>
          <dd className="font-mono text-ui-fg-base">{update.fromVersion ?? "?"}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-ui-fg-muted">{t("updates.history.card.versionTo")}</dt>
          <dd className="font-mono text-ui-fg-base">{update.toVersion ?? "?"}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-ui-fg-muted">{t("updates.history.card.start")}</dt>
          <dd className="text-ui-fg-subtle">{new Date(startDate).toLocaleString()}</dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-ui-fg-muted">{t("updates.history.card.end")}</dt>
          <dd className="text-ui-fg-subtle">
            {update.finishedAt ? new Date(update.finishedAt).toLocaleString() : "—"}
          </dd>
        </div>
      </dl>
    </div>
  )
}

/**
 * Onglet « Historique » : liste paginée des mises à jour / rollbacks, filtres
 * de statut (pill desktop, dropdown mobile) et bouton "Voir plus". Le rollback
 * est une double-confirmation gérée par l'appelant (onRollbackRequest).
 */
export function HistoryTab({
  items,
  total,
  hasMore,
  fetching,
  offset,
  status,
  onStatusChange,
  running,
  trackedId,
  pendingRollback,
  rollbackLoading,
  onRollbackRequest,
  onLoadMore,
}: {
  items: SystemUpdateRecord[]
  total?: number
  hasMore: boolean
  fetching: boolean
  offset: number
  status: string
  onStatusChange: (s: string) => void
  running: boolean
  trackedId: string | null
  pendingRollback: string | null
  rollbackLoading: boolean
  onRollbackRequest: (id: string) => void
  onLoadMore: () => void
}) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="updates-history-title">
      <Container className="p-6">
        <div className="mb-4 flex items-center justify-between gap-2">
          <Heading level="h3" id="updates-history-title">{t("updates.history.title")}</Heading>
          <div className="flex items-center gap-2">
            {/* Mobile : dropdown icône sur la ligne du titre (masqué desktop) */}
            <div className="sm:hidden">
              <DropdownMenu>
                <DropdownMenu.Trigger asChild>
                  <IconButton variant="transparent" className="border border-ui-border-base">
                    <Funnel />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content>
                  {STATUS_FILTERS.map((f) => (
                    <DropdownMenu.Item key={f.value} onClick={() => onStatusChange(f.value)}>
                      <span>{t(f.labelKey)}</span>
                      {status === f.value && (
                        <Check className="text-ui-fg-interactive" aria-hidden />
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu>
            </div>
            {/* Desktop : pastilles de filtre (masquées mobile) */}
            <div className="hidden flex-wrap gap-1 sm:flex">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => onStatusChange(f.value)}
                  className={
                    status === f.value
                      ? "rounded-full bg-ui-button-inverted px-3 py-1 text-xs text-white"
                      : "rounded-full bg-ui-bg-subtle px-3 py-1 text-xs text-ui-fg-muted hover:text-ui-fg-base"
                  }
                >
                  {t(f.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!items.length ? (
          <EmptyState
            icon={History}
            title={
              status === "all"
                ? t("updates.history.empty.allTitle")
                : t("updates.history.empty.filteredTitle")
            }
            hint={
              status === "all"
                ? t("updates.history.empty.allHint")
                : t("updates.history.empty.filteredHint")
            }
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {groupHistory(items).map((g) => {
              if (g.kind === "orphan") {
                // Rollback dont l'update source n'est pas dans la page
                // courante (pagination) : affichée seule, en toute info.
                return (
                  <HistoryCard
                    key={g.update.id}
                    update={g.update}
                    action="rollback"
                    highlighted={g.update.id === trackedId}
                    t={t}
                  />
                )
              }
              return (
                <div key={g.update.id} className="flex flex-col gap-1.5">
                  <HistoryCard
                    update={g.update}
                    action="update"
                    highlighted={g.update.id === trackedId}
                    onRollback={() => onRollbackRequest(g.update.id)}
                    rollbackPending={pendingRollback === g.update.id}
                    rollbackLoading={rollbackLoading}
                    disabled={running}
                    t={t}
                  />
                  {g.rollbacks.map((rb) => (
                    <HistoryCard
                      key={rb.id}
                      update={rb}
                      action="rollback"
                      highlighted={rb.id === trackedId}
                      t={t}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
        {!!items.length && hasMore && (
          <Button
            variant="secondary"
            size="small"
            className="mt-3"
            disabled={running}
            isLoading={fetching}
            onClick={onLoadMore}
          >
            {t("updates.history.loadMore", {
              count: Math.max(0, (total ?? 0) - items.length - offset),
            })}
          </Button>
        )}
      </Container>
    </section>
  )
}