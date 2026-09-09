import { useEffect, useState } from "react"
import type { ElementType } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { Badge, Button, Container, Heading, Text, clx } from "@medusajs/ui"
import {
  ArrowPath, CheckCircle, CircleCheckSolid, CircleStack, CircleXmarkSolid, CloudArrowDown,
  CubeSolid, Globe, Layers3, Server, Tag, XMark,
} from "@medusajs/icons"
import type { SystemUpdateRecord, UpdatesCheck } from "../../lib/api"
import { channelLabels, statusLabels } from "./updatesShared"

/** Icônes Medusa pour chaque étape du stepper (labels traduits via stepLabel). */
const STEP_ICON: Record<string, ElementType> = {
  backup: CircleStack,
  version: Tag,
  pull: CubeSolid,
  web: Globe,
  api: Server,
  pipeline: Layers3,
  restore: CircleStack,
}

const STEP_LABEL: Record<string, string> = {
  backup: "updates.steps.backup",
  version: "updates.steps.version",
  pull: "updates.steps.pull",
  web: "updates.steps.web",
  api: "updates.steps.api",
  pipeline: "updates.steps.pipeline",
  restore: "updates.steps.restore",
}

function stepLabel(name: string, t: TFunction): string {
  return STEP_LABEL[name] ? t(STEP_LABEL[name]) : name
}

/** Pastille d'état d'une étape du stepper (icône Medusa + formes/animations). */
function StepBadge({ step, t }: { step: { name: string; status: string }; t: TFunction }) {
  const Icon = STEP_ICON[step.name] ?? Layers3
  if (step.status === "success") {
    return (
      <span className="hb-animate-step-pop relative flex h-9 w-9 items-center justify-center" aria-label={t("updates.steps.status.success")}>
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-uf-green bg-ui-bg-success text-uf-green">
          <CheckCircle className="h-4 w-4" aria-hidden />
        </span>
      </span>
    )
  }
  if (step.status === "failed") {
    return (
      <span
        className="hb-animate-step-pop flex h-9 w-9 items-center justify-center rounded-full bg-ui-bg-error text-ui-fg-error"
        aria-label={t("updates.steps.status.failed")}
      >
        <XMark className="h-4 w-4" aria-hidden />
      </span>
    )
  }
  if (step.status === "running") {
    return (
      <span className="relative flex h-9 w-9 items-center justify-center" aria-label={t("updates.steps.status.running")}>
        <span className="hb-animate-node-pulse absolute inset-0 rounded-full bg-blue-500" aria-hidden />
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full border-2 border-blue-500 bg-blue-50 text-blue-600">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </span>
    )
  }
  return (
    <span
      className="flex h-9 w-9 items-center justify-center rounded-full bg-ui-bg-base-pressed text-ui-fg-muted"
      aria-label={t("updates.steps.status.pending")}
    >
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  )
}

/** Lien entre deux étapes : se remplit en scaleX quand l'étape précède passe. */
function StepLink({ status }: { status: string }) {
  const done = status === "success"
  const active = status === "running"
  return (
    <span
      aria-hidden
      className={clx(
        "mb-5 h-0.5 w-6 origin-left sm:w-10",
        done
          ? "scale-x-100 bg-blue-500"
          : active
            ? "scale-x-100 animate-pulse bg-blue-500/50"
            : "scale-x-0 bg-ui-border-base",
        "transition-transform duration-500",
      )}
      style={{ transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}
    />
  )
}

/** Petit loader circulaire (icône Medusa animée) pendant la préparation. */
function CircleDottedLoader() {
  return (
    <span className="relative flex h-5 w-5 items-center justify-center" aria-hidden>
      <span className="hb-animate-node-pulse absolute inset-0 rounded-full bg-blue-500" />
      <CircleStack className="relative h-4 w-4 text-blue-600" />
    </span>
  )
}

/** Formate une durée ms en « 45s » / « 1m 05s ». */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m === 0 ? `${s}s` : `${m}m ${s.toString().padStart(2, "0")}s`
}

/**
 * Contenu du pipeline (affiché dans la carte) : stepper visuel à icônes,
 * échecs d'étapes, progression + durée. Aucun log : un seul retour visuel.
 */
function PipelineContent({ update, live, t }: { update: SystemUpdateRecord; live: boolean; t: TFunction }) {
  const steps = update.steps ?? []
  const done = steps.filter((s) => s.status === "success").length
  const progress = steps.length ? Math.round((done / steps.length) * 100) : 0

  // Durée : tick 1s pendant running, fixe (startedAt → finishedAt) sinon.
  const startedAt = update.startedAt ? new Date(update.startedAt).getTime() : null
  const endedAt = update.finishedAt ? new Date(update.finishedAt).getTime() : null
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  const durationMs = startedAt ? (endedAt ?? now) - startedAt : null

  const failedSteps = steps.filter((s) => s.status === "failed" && s.error)

  return (
    <>
      {/* Stepper horizontal */}
      {steps.length > 0 ? (
        <ol className="flex flex-wrap items-start gap-2">
          {steps.map((s, i) => {
            const last = i === steps.length - 1
            return (
              <li
                key={s.name}
                className="hb-animate-fade-up flex min-w-0 items-center gap-2"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <div className="flex flex-col items-center gap-1.5">
                  <StepBadge key={`${s.name}-${s.status}`} step={s} t={t} />
                  <span
                    className={clx(
                      "text-xs",
                      s.status === "running"
                        ? "font-medium text-ui-fg-base"
                        : "text-ui-fg-muted",
                    )}
                  >
                    {stepLabel(s.name, t)}
                  </span>
                </div>
                {!last && <StepLink status={s.status} />}
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="flex items-center gap-2">
          <CircleDottedLoader />
          <Text size="small" className="text-ui-fg-muted">{t("updates.pipeline.preparing")}</Text>
        </div>
      )}

      {failedSteps.length > 0 && (
        <div className="mt-4 rounded-md bg-ui-bg-base-pressed p-3">
          <Text size="xsmall" weight="plus" className="text-ui-fg-error">
            {t("updates.pipeline.stepFailed")}
          </Text>
          {failedSteps.map((s) => (
            <Text key={s.name} size="xsmall" className="mt-1 text-ui-fg-subtle">
              {stepLabel(s.name, t)} : {s.error}
            </Text>
          ))}
        </div>
      )}

      {/* Progression + durée */}
      <div className="mt-5 flex items-center gap-3 border-t border-ui-border-base pt-4">
        <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ui-bg-base-pressed">
          <div
            className="hb-progress-fill absolute inset-y-0 left-0 w-full rounded-full bg-blue-500"
            style={{ transform: `scaleX(${progress / 100})` }}
          />
          {live && <div className="hb-animate-shimmer absolute inset-0 rounded-full" aria-hidden />}
        </div>
        <span className="w-9 shrink-0 text-right font-mono text-xs text-ui-fg-muted">
          {progress}%
        </span>
        {durationMs !== null && (
          <span className="shrink-0 font-mono text-xs text-ui-fg-muted">
            · {formatDuration(durationMs)}
          </span>
        )}
      </div>
    </>
  )
}

/** Bannière de verdict (succès / échec / rollback) avec check dessiné. */
function VerdictBanner({
  update,
  onReload,
  onClose,
  t,
}: {
  update: SystemUpdateRecord
  onReload: () => void
  onClose: () => void
  t: TFunction
}) {
  const ok = update.status === "success"
  const rolledBack = update.status === "rolled_back"
  // Version réellement restaurée : l'enregistrement rollback a son propre
  // toVersion (= cible du restore), une apply auto-rollbackée garde le sien
  // (fromVersion). Les deux pointent vers la version redeployée.
  const restored = update.rollbackOfId ? update.toVersion : update.fromVersion
  return (
    <div
      className={clx(
        "mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4",
        ok
          ? "border-ui-border-base bg-ui-bg-subtle"
          : "border-ui-border-error bg-ui-bg-error/30",
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={clx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
            ok ? "bg-ui-bg-success text-uf-green" : "bg-ui-bg-error text-ui-fg-error",
          )}
        >
          {ok ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
              <path
                pathLength={1}
                d="M4.5 12.5l4.8 4.8L19.5 7"
                className="hb-draw-check"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <CircleXmarkSolid className="h-5 w-5" />
          )}
        </span>
        <div>
          <Text weight="plus">
            {ok
              ? t("updates.verdict.success")
              : rolledBack
                ? t("updates.verdict.rolledBack")
                : t("updates.verdict.failed")}
          </Text>
          <Text size="small" className="mt-0.5 text-ui-fg-muted">
            {ok
              ? t("updates.verdict.successDesc", {
                  from: update.fromVersion ?? "?",
                  to: update.toVersion ?? "?",
                })
              : rolledBack
                ? t("updates.verdict.rolledBackDesc", { version: restored ?? "?" })
                : update.error?.slice(0, 160) ?? t("updates.verdict.checkHistory")}
          </Text>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="secondary" size="small" onClick={onReload}>
          <ArrowPath />
          {t("updates.verdict.reload")}
        </Button>
        <Button variant="primary" size="small" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </div>
  )
}

/**
 * Carte d'installation : état courant (version + dispo) OU pipeline live de
 * l'update en cours. Idle : « Mettre à jour » si version plus récente sur le
 * canal. Live : verdict + stepper temps réel.
 */
export function UpdatesHero({
  data,
  isError,
  live,
  running,
  connected,
  onUpdate,
  onCloseLive,
  updatesDisabled = false,
}: {
  data: UpdatesCheck | undefined
  isError: boolean
  live: SystemUpdateRecord | null
  running: boolean
  connected: boolean
  onUpdate: () => void
  onCloseLive: () => void
  updatesDisabled?: boolean
}) {
  const { t } = useTranslation()
  const clabels = channelLabels(t)
  const slabels = statusLabels(t)
  const liveView = !!live
  const updateTerminal =
    liveView && ["success", "failed", "rolled_back"].includes(live!.status)
  const currentVersion = !data?.currentVersion
    ? "…"
    : data.currentVersion === "unknown"
      ? t("updates.version.dev")
      : data.currentVersion;
  const activeChannel = data?.updateChannel ?? "stable"
  const lastCheckLabel = data
    ? t("updates.hero.lastCheck", {
        date: new Date(data.lastCheckAt).toLocaleString(),
      })
    : null
  const isUpToDate = !!data && !data.updateAvailable

  return (
    <Container className="mb-4 overflow-hidden p-6 sm:p-8">
      <div key={liveView ? live!.id : "idle"} className="hb-animate-card-in">
        {liveView && live ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Text size="xsmall" className="text-ui-fg-muted uppercase tracking-wide">
                  {running ? t("updates.hero.running") : t("updates.hero.result")}
                </Text>
                <Heading level="h3" className="mt-0.5 font-mono">
                  {live.fromVersion ?? "?"} → {live.toVersion ?? "?"}
                </Heading>
              </div>
              <div className="flex items-center gap-2">
                {running ? (
                  <Badge color="blue" className="animate-pulse motion-reduce:animate-none">
                    {connected ? t("updates.hero.live") : t("updates.hero.reconnecting")}
                  </Badge>
                ) : (
                  <Badge
                    color={
                      live.status === "success" ? "green"
                        : live.status === "failed" ? "red"
                          : "orange"
                    }
                  >
                    {slabels[live.status]?.label ?? live.status}
                  </Badge>
                )}
              </div>
            </div>

            {updateTerminal && (
              <VerdictBanner
                update={live}
                onReload={() => window.location.reload()}
                onClose={onCloseLive}
                t={t}
              />
            )}

            <div className="mt-5">
              <PipelineContent update={live} live={running} t={t} />
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-4xl font-semibold leading-none text-ui-fg-base sm:text-5xl">
                    {currentVersion}
                  </span>
                  {data?.updateAvailable && (
                    <Badge color="orange">{t("updates.hero.updateAvailable")}</Badge>
                  )}
                </div>
                {data?.updateAvailable && data.latest ? (
                  <Text className="mt-2 text-ui-fg-subtle">
                    {t("updates.hero.latestPublished", {
                      version: data.latest.version,
                      date: data.latest.publishedAt
                        ? new Date(data.latest.publishedAt).toLocaleDateString()
                        : t("updates.hero.recently"),
                      channel: clabels[activeChannel].label.toLowerCase(),
                    })}
                  </Text>
                ) : isUpToDate ? (
                  <Text className="mt-2 flex items-center gap-1.5 text-ui-fg-subtle">
                    <CircleCheckSolid className="h-4 w-4 shrink-0 text-ui-fg-success" aria-hidden />
                    {t("updates.hero.upToDate", {
                      version: currentVersion,
                      channel: clabels[activeChannel].label.toLowerCase(),
                    })}
                  </Text>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {data?.updateAvailable && (
                  <Button variant="primary" disabled={running || updatesDisabled} onClick={onUpdate}>
                    <CloudArrowDown />
                    {t("updates.hero.update")}
                  </Button>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ui-border-base pt-3 text-xs text-ui-fg-muted">
              {lastCheckLabel && <span>{lastCheckLabel}</span>}
              {data?.degraded && (
                <span className="text-amber-600">
                  {t("updates.hero.degraded", { detail: data.degraded.slice(0, 80) })}
                </span>
              )}
              {isError && (
                <span className="text-red-600">
                  {t("updates.hero.checkFailed")}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </Container>
  )
}