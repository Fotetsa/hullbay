import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Alert, Badge, Button, Label, Prompt, Switch, Text, toast, clx,
} from "@medusajs/ui"
import { ArrowPath, CircleCheckSolid } from "@medusajs/icons"
import { api, type SystemUpdateRecord, type UpdateChannel } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useUpdatesCheck } from "../lib/useUpdates"
import { useUpdateSocket } from "../lib/useUpdateSocket"
import { PageContainer, PageHeader } from "../components/PageHeader"
import { CHANNEL_LABELS, releaseType } from "../components/updates/updatesShared"
import { UpdatesHero } from "../components/updates/UpdatesHero"
import { VersionsTab } from "../components/updates/VersionsTab"
import { HistoryTab } from "../components/updates/HistoryTab"
import { useTranslation } from 'react-i18next'

/**
 * Page Mises à jour (owner uniquement, la nav la masque sinon) :
 *  - toggle « Version bêta » dans le header (canal stable/bêta)
 *  - carte d'installation : version courante, dernière version dispo du canal
 *    ou « Vous êtes à jour » (aucun bouton quand à jour)
 *  - confirmation de la mise à jour (modal minimal) puis pipeline live DANS
 *    la carte, avec tous les autres éléments désactivés pendant l'update
 *  - historique paginé (filtres statut + rollback) et versions publiées
 *    (installation d'une version intermédiaire depuis la liste)
 */

// « Vérifier maintenant » volontairement masqué : une mise à jour de sécurité ne
// doit pas attendre le prochain check (6 h). Réactiver en passant ce flag à true.
const SHOW_MANUAL_CHECK = false

const HISTORY_PAGE_SIZE = 20

export function UpdatesPage() {
  const { t } = useTranslation()
  const updates = useUpdatesCheck()
  const [modalOpen, setModalOpen] = useState(false)
  const [historyStatus, setHistoryStatus] = useState("all")
  const [historyOffset, setHistoryOffset] = useState(0)
  const [activeTab, setActiveTab] = useState<"releases" | "history">("releases")
  const [expandedTag, setExpandedTag] = useState<string | null>(null)
  // Filtre de la carte "Versions publiées" : indépendant du canal de l'instance.
  const [releaseFilter, setReleaseFilter] = useState<"all" | "stable" | "beta" | "rc">("all")

  // Releases des DEUX canaux (stable + beta mélangés) pour la carte "Versions
  // publiées" — le filtre Tous/Stable/Beta/RC est local à la carte.
  const allReleases = useQuery({
    queryKey: ["updates-releases-all"],
    queryFn: () => api.updatesCheck({ channel: "all" }),
    staleTime: 6 * 60 * 60 * 1000,
  })
  const filteredReleases = useMemo(() => {
    const list = allReleases.data?.releases ?? []
    if (releaseFilter === "all") return list
    return list.filter((r) => releaseType(r) === releaseFilter)
  }, [allReleases.data, releaseFilter])

  const {
    data: history,
    isFetching: historyFetching,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ["updates-history", historyStatus, historyOffset],
    queryFn: () =>
      api.updatesHistory({
        limit: HISTORY_PAGE_SIZE,
        offset: historyOffset,
        status: historyStatus === "all" ? undefined : (historyStatus as SystemUpdateRecord["status"]),
      }),
  })

  // L'update en cours : la plus récente running/pending de l'historique (par
  // ex. rechargée en plein apply), sinon celle qu'on a lancée cette session.
  const runningFromHistory = useMemo(
    () =>
      (history?.items ?? []).find((h) => h.status === "running" || h.status === "pending")
        ?.id ?? null,
    [history],
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const trackedId = activeId ?? runningFromHistory

  // Suivi de l'update active : le poll 2s est le filet de sécurité — le socket
  // la met à jour en direct, mais il disparaît pendant le redémarrage de l'API
  // (l'update se termine au boot suivant).
  const qc = useQueryClient()
  const liveStatusRef = useRef<string | undefined>(undefined)
  const { data: live } = useQuery<SystemUpdateRecord>({
    queryKey: ["updates-status", trackedId],
    queryFn: () => api.updatesStatus(trackedId!),
    refetchInterval: () => {
      const s = liveStatusRef.current
      return trackedId && s && (s === "running" || s === "pending") ? 2000 : false
    },
    enabled: !!trackedId,
  })
  liveStatusRef.current = live?.status

  // Events socket : on rafraîchit la query du pipeline directement pour que la
  // timeline réagisse au temps réel (le poll 2s reste un filet de sécurité).
  const { connected } = useUpdateSocket({
    onStep: () => {
      refetchHistory()
      qc.invalidateQueries({ queryKey: ["updates-status"] })
    },
    onProgress: () => {
      refetchHistory()
      qc.invalidateQueries({ queryKey: ["updates-status"] })
    },
    onDone: (p) => {
      refetchHistory()
      updates.refetch()
      qc.invalidateQueries({ queryKey: ["updates-status"] })
      if (p.status === "success") {
        toast.success(t('updates.toast.appliedSuccess', { version: p.toVersion }), {
          description: t('updates.toast.appliedSuccessDesc', { fromVersion: p.fromVersion, toVersion: p.toVersion }),
        })
      } else if (p.status === "rolled_back") {
        toast.info(t('updates.toast.rollbackInfo'), {
          description: t('updates.toast.rollbackInfoDesc', { toVersion: p.toVersion }),
        })
      }
    },
    onError: (p) => {
      refetchHistory()
      qc.invalidateQueries({ queryKey: ["updates-status"] })
      if (p.updateId === trackedId) {
        toast.error(t('updates.toast.failed'), { description: p.error })
      }
    },
  })

  // ---- Canal (toggle header) ----
  const setChannel = useMutationToast({
    mutationFn: (channel: UpdateChannel) => api.setUpdateChannel(channel),
    success: (_, channel) => t('updates.toast.channelChanged', { channel: CHANNEL_LABELS[channel].label.toLowerCase() }),
    invalidate: [["updates-check"]],
  })

  // ---- Apply (confirmation : dernière version du canal ou version ciblée) ----
  const [applyError, setApplyError] = useState<string | null>(null)
  // Version ciblée depuis la liste des releases (null = dernière du canal).
  const [targetVersionOverride, setTargetVersionOverride] = useState<string | null>(null)
  const apply = useMutationToast({
    mutationFn: (opts: { channel?: UpdateChannel; version?: string }) =>
      api.applyUpdate(opts),
    success: t('updates.toast.applyStarted'),
    onSuccess: (result) => {
      setModalOpen(false)
      setTargetVersionOverride(null)
      setActiveId(result.id)
      refetchHistory()
      updates.refetch()
    },
    onError: (err) => {
      setApplyError(err.message)
    },
  })
  const openConfirm = (version?: string) => {
    setApplyError(null)
    setTargetVersionOverride(version ?? null)
    setModalOpen(true)
  }
  const confirmVersion = targetVersionOverride ?? updates.data?.latest?.version ?? null

  // ---- Rollback (double-confirmation inline) ----
  const [pendingRollback, setPendingRollback] = useState<string | null>(null)
  // Timer d'auto-désarmement : conservé dans une ref pour le clear à la
  // confirmation (sinon il effacerait l'état pendant la mutation rollback).
  const disarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disarm = (id: string) => {
    if (disarmTimerRef.current) {
      clearTimeout(disarmTimerRef.current)
      disarmTimerRef.current = null
    } else {
      disarmTimerRef.current = setTimeout(() => {
        disarmTimerRef.current = null
        setPendingRollback((cur) => (cur === id ? null : cur))
      }, 4000)
    }
  }
  const rollback = useMutationToast({
    mutationFn: (id: string) => api.rollbackUpdate(id),
    success: t('updates.toast.rollbackStarted'),
    onSuccess: (result) => {
      setPendingRollback(null)
      setActiveId(result.id)
      refetchHistory()
    },
    onError: () => setPendingRollback(null),
  })
  const handleRollbackRequest = (id: string) => {
    if (pendingRollback === id) {
      // Confirmation : clear le timer d'auto-désarmement (la mutation dure
      // plus longtemps que 4 s).
      if (disarmTimerRef.current) {
        clearTimeout(disarmTimerRef.current)
        disarmTimerRef.current = null
      }
      rollback.mutate(id)
    } else if (!rollback.isPending) {
      setPendingRollback(id)
      disarm(id)
    }
  }

  const liveView = !!trackedId && !!live
  const running = liveView && (live!.status === "running" || live!.status === "pending")

  // Confirmation navigateur native pour TOUT rechargement pendant l'update :
  // le navigateur affiche un dialogue natif non contournable.
  useEffect(() => {
    if (!running) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [running])

  const currentVersion = updates.data?.currentVersion ?? "…"
  const activeChannel = updates.data?.updateChannel ?? "stable"

  return (
    <PageContainer size="5xl">
      <PageHeader
        title={t('updates.pageTitle')}
        subtitle={t('updates.pageSubtitle')}
        actions={
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="updates-beta-toggle"
                checked={activeChannel === "beta"}
                disabled={running || setChannel.isPending}
                onCheckedChange={(checked) => setChannel.mutate(checked ? "beta" : "stable")}
              />
              <Label htmlFor="updates-beta-toggle" size="small" className="text-ui-fg-base">
                {t('updates.betaLabel')}
              </Label>
            </div>
            {SHOW_MANUAL_CHECK && (
              <Button
                variant="secondary"
                onClick={() => {
                  refetchHistory()
                  updates.refetch()
                }}
                isLoading={updates.isFetching || historyFetching}
              >
                <ArrowPath />
                {t('updates.checkNow')}
              </Button>
            )}
          </div>
        }
      />

      {/* ── Carte installation : état courant OU pipeline live ───────────── */}
      <UpdatesHero
        data={updates.data}
        isError={updates.isError}
        live={liveView ? live : null}
        running={running}
        connected={connected}
        onUpdate={() => openConfirm()}
        onCloseLive={() => setActiveId(null)}
      />

      {/* Pendant l'update : tout le reste est verrouillé et atténué. */}
      <div
        aria-busy={running}
        className={clx("flex flex-col gap-4", running && "pointer-events-none select-none opacity-60")}
      >
        {/* ── Onglets : versions publiées (défaut) / historique ──────────── */}
        <div className="flex justify-start">
          <div
            role="tablist"
            aria-label={t('updates.tabs.ariaLabel')}
            className="flex w-full rounded-md border border-ui-border-base bg-ui-bg-subtle p-0.5 sm:inline-flex sm:w-auto"
          >
            {(
              [
                { value: "releases", label: t('updates.tabs.releases') },
                { value: "history", label: t('updates.tabs.history') },
              ] as const
            ).map((tabItem) => {
              const active = activeTab === tabItem.value
              return (
                <button
                  key={tabItem.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(tabItem.value)}
                  className={clx(
                    "flex-1 rounded px-4 py-2 text-sm font-medium transition-colors sm:flex-none",
                    active
                      ? "bg-ui-button-inverted text-white"
                      : "text-ui-fg-muted hover:text-ui-fg-base",
                  )}
                >
                  {tabItem.label}
                </button>
              )
            })}
          </div>
        </div>

        {activeTab === "releases" ? (
          <VersionsTab
            releases={filteredReleases}
            loading={!allReleases.data}
            filter={releaseFilter}
            onFilterChange={setReleaseFilter}
            expandedTag={expandedTag}
            onToggle={(tag) => setExpandedTag((cur) => (cur === tag ? null : tag))}
            currentVersion={currentVersion}
            running={running}
            onInstall={(version) => openConfirm(version)}
          />
        ) : (
          <HistoryTab
            items={history?.items ?? []}
            total={history?.total}
            hasMore={!!history?.items?.length && !!history?.hasMore}
            fetching={historyFetching}
            offset={historyOffset}
            status={historyStatus}
            onStatusChange={(s) => {
              setHistoryStatus(s)
              setHistoryOffset(0)
            }}
            running={running}
            trackedId={trackedId}
            pendingRollback={pendingRollback}
            rollbackLoading={rollback.isPending}
            onRollbackRequest={handleRollbackRequest}
            onLoadMore={() => setHistoryOffset((o) => o + HISTORY_PAGE_SIZE)}
          />
        )}
      </div>

      {/* ── Popover : simple confirmation de la dernière version du canal ── */}
      <Prompt open={modalOpen} onOpenChange={(o) => { setModalOpen(o); if (!o) setTargetVersionOverride(null) }} variant="confirmation">
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{t('updates.confirmModal.title')}</Prompt.Title>
            <Prompt.Description>
              {t('updates.confirmModal.installText')}{" "}
              <span className="font-mono text-ui-fg-base">{confirmVersion ?? "…"}</span>{" "}
              {t('updates.confirmModal.channelText', { channel: CHANNEL_LABELS[activeChannel].label.toLowerCase() })}
            </Prompt.Description>
          </Prompt.Header>
          <div className="flex flex-col gap-2 px-6 text-sm text-ui-fg-subtle">
            {targetVersionOverride && (
              <Badge className="w-fit" size="small">{t('updates.confirmModal.intermediateBadge')}</Badge>
            )}
            <Text size="small">
              {t('updates.confirmModal.notice')}
            </Text>
            <ul className="flex flex-col gap-1.5">
              <li className="flex items-start gap-2">
                <CircleCheckSolid className="mt-0.5 h-4 w-4 shrink-0 text-ui-fg-success" aria-hidden />
                {t('updates.confirmModal.stepBackup')}
              </li>
              <li className="flex items-start gap-2">
                <CircleCheckSolid className="mt-0.5 h-4 w-4 shrink-0 text-ui-fg-success" aria-hidden />
                {t('updates.confirmModal.stepRedeploy')}
              </li>
              <li className="flex items-start gap-2">
                <CircleCheckSolid className="mt-0.5 h-4 w-4 shrink-0 text-ui-fg-success" aria-hidden />
                {t('updates.confirmModal.stepRollback')}
              </li>
            </ul>
          </div>
          {applyError && (
            <div className="px-6 pt-3">
              <Alert variant="error" dismissible>
                <Text size="small">{applyError}</Text>
              </Alert>
            </div>
          )}
          <Prompt.Footer>
            <Prompt.Cancel>{t('updates.actions.cancel')}</Prompt.Cancel>
            <Button
              size="small"
              variant="primary"
              isLoading={apply.isPending}
              disabled={!confirmVersion || running}
              onClick={() => apply.mutate({ channel: activeChannel, version: targetVersionOverride ?? undefined })}
            >
              {t('updates.actions.confirm')}
            </Button>
          </Prompt.Footer>
        </Prompt.Content>
      </Prompt>
    </PageContainer>
  )
}