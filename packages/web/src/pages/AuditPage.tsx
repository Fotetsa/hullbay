import { useState } from "react"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import { Badge, Button, Drawer, Heading, Select, Table, Text } from "@medusajs/ui"
import { ArrowPath, DocumentText, Spinner } from "@medusajs/icons"
import { api, type AuditEntry } from "../lib/api"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ListContainer } from "../components/ListContainer"
import { EmptyState } from "../components/EmptyState"
import { useTranslation } from 'react-i18next'

const PAGE_SIZE = 50

const ACTIONS = [
  "deploy.success",
  "deploy.failed",
  "destroy",
  "rebuild",
  "server.provisioned",
  "server.removed",
  "server.role.changed",
  "registry.set",
  "secret.set",
  "secret.removed",
  "user.created",
  "user.role.changed",
  "user.deleted",
  "mfa.enabled",
  "autoscale.applied",
  "prune.finished",
]

function actionColor(action: string): "red" | "orange" | "green" | "grey" {
  if (action.includes("failed") || action === "destroy" || action.includes("removed") || action === "user.deleted") {
    return "red"
  }
  if (action.includes("success") || action === "server.provisioned" || action === "user.created") {
    return "green"
  }
  if (action.includes("role.changed") || action === "autoscale.applied") return "orange"
  return "grey"
}

export function AuditPage() {
  const { t } = useTranslation() 
  const [action, setAction] = useState<string>("__all")
  const [offset, setOffset] = useState(0)
  const [detailEntry, setDetailEntry] = useState<AuditEntry | null>(null)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["audit", action, offset],
    queryFn: () =>
      api.audit({
        limit: PAGE_SIZE,
        offset,
        action: action === "__all" ? undefined : action,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  })

  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <PageContainer size="5xl">
      <PageHeader
        title={t('auditLog.title')}
        subtitle={t('auditLog.subtitle')}
        actions={
          <div className="flex items-center gap-2">
            <div className="w-56">
              <Select
                value={action}
                onValueChange={(v) => {
                  setAction(v)
                  setOffset(0)
                }}
              >
                <Select.Trigger>
                  <Select.Value placeholder={t('auditLog.filterAllActions')} />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="__all">{t('auditLog.filterAllActions')}</Select.Item>
                  {ACTIONS.map((a) => (
                    <Select.Item key={a} value={a}>
                      {a}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
            <Button variant="secondary" size="small" onClick={() => refetch()} aria-label={t('auditLog.refresh')}>
              <ArrowPath /> {t('auditLog.refresh')}
            </Button>
            {isFetching && !isLoading && (
              <Spinner className="animate-spin text-ui-fg-muted" />
            )}
          </div>
        }
      />

      <ListContainer
        title={t('auditLog.eventsTitle')}
        subtitle={total ? t('auditLog.eventsCount', { count: total }) : undefined}
        isEmpty={!isLoading && entries.length === 0}
        empty={
          <EmptyState
            icon={DocumentText}
            title={t('auditLog.emptyTitle')}
            description={t('auditLog.emptyDescription')}
          />
        }
      >
        <div className="overflow-x-auto px-2 pb-2" aria-busy={isFetching}>
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="animate-spin text-ui-fg-muted" />
            </div>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>{t('auditLog.table.date')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('auditLog.table.action')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('auditLog.table.user')}</Table.HeaderCell>
                  <Table.HeaderCell>{t('auditLog.table.target')}</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {entries.map((e) => (
                  <AuditRow key={e.id} e={e} onSelect={() => setDetailEntry(e)} />
                ))}
              </Table.Body>
            </Table>
          )}
        </div>
        <Drawer open={!!detailEntry} onOpenChange={(open) => !open && setDetailEntry(null)}>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.Title>{t('auditLog.drawer.title')}</Drawer.Title>
            </Drawer.Header>
            <Drawer.Body className="flex flex-col gap-4 overflow-y-auto">
              {detailEntry ? (
                <div className="space-y-4">
                  <div>
                    <Heading level="h3">{detailEntry.action}</Heading>
                    <Badge color={actionColor(detailEntry.action)} size="2xsmall" className="mt-2">
                      {detailEntry.action}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Text size="small" className="text-ui-fg-muted">
                        {t('auditLog.table.date')}
                      </Text>
                      <Text>{new Date(detailEntry.createdAt).toLocaleString()}</Text>
                    </div>
                    <div>
                      <Text size="small" className="text-ui-fg-muted">
                        {t('auditLog.table.user')}
                      </Text>
                      <Text>{detailEntry.userEmail ?? t('auditLog.system')}</Text>
                    </div>
                    <div>
                      <Text size="small" className="text-ui-fg-muted">
                        {t('auditLog.table.target')}
                      </Text>
                      <Text>
                        {detailEntry.projectId
                          ? t('auditLog.targetProject', { id: detailEntry.projectId.slice(0, 8) })
                          : detailEntry.serverId
                          ? t('auditLog.targetServer', { id: detailEntry.serverId.slice(0, 8) })
                          : "—"}
                      </Text>
                    </div>
                  </div>
                  <div>
                    <Text size="small" className="text-ui-fg-muted">
                      {t('auditLog.drawer.payload')}
                    </Text>
                    <pre className="mt-2 overflow-x-auto rounded border border-ui-border-base bg-ui-bg-subtle p-3 text-xs">
                      {JSON.stringify(detailEntry.payload ?? {}, null, 2)}
                    </pre>
                  </div>
                </div>
              ) : (
                <Text className="text-ui-fg-subtle">{t('auditLog.drawer.selectPrompt')}</Text>
              )}
            </Drawer.Body>
          </Drawer.Content>
        </Drawer>
        <div className="flex items-center justify-between px-6 py-3">
          <Text size="small" className="text-ui-fg-subtle">
            {t('auditLog.pagination.pageInfo', { page, pages })}
          </Text>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t('auditLog.pagination.prev')}
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {t('auditLog.pagination.next')}
            </Button>
          </div>
        </div>
      </ListContainer>
    </PageContainer>
  )
}

function AuditRow({ e, onSelect }: { e: AuditEntry; onSelect: () => void }) {
  const { t } = useTranslation() // Hook également ici pour le sous-composant
  const target =
    e.projectId
      ? t('auditLog.targetProject', { id: e.projectId.slice(0, 8) })
      : e.serverId
        ? t('auditLog.targetServer', { id: e.serverId.slice(0, 8) })
        : (e.payload as { email?: string; role?: string } | null)?.email ?? "—"

  return (
    <Table.Row
      className="cursor-pointer transition hover:bg-ui-bg-subtle"
      onClick={onSelect}
    >
      <Table.Cell>
        <Text size="small" className="whitespace-nowrap text-ui-fg-subtle">
          {new Date(e.createdAt).toLocaleString()}
        </Text>
      </Table.Cell>
      <Table.Cell>
        <Badge size="2xsmall" color={actionColor(e.action)}>
          {e.action}
        </Badge>
      </Table.Cell>
      <Table.Cell>{e.userEmail ?? <span className="text-ui-fg-muted">{t('auditLog.system')}</span>}</Table.Cell>
      <Table.Cell>
        <Text size="small" className="text-ui-fg-subtle">
          {target}
        </Text>
      </Table.Cell>
    </Table.Row>
  )
}