import { useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge, Button, Heading, Text, toast, usePrompt } from "@medusajs/ui"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"
import type { Node } from "@hullbay/shared"
import { api, type BackupArtifact, type BackupPolicy, type BackupTarget } from "../../lib/api"
import { BackupDestinationPanel } from "./BackupDestinationPanel"
import { BackupPolicyPanel } from "./BackupPolicyPanel"
import { formatBytes, formatDate, shortChecksum } from "./format"

/**
 * Section « Sauvegarde » de l'inspecteur.
 *
 * Ordre de lecture = ordre des questions que se pose l'utilisateur :
 *   1. est-ce que ma donnée est sauvegardée ?  → bandeau d'état
 *   2. où, quand, combien de temps ?           → politiques
 *   3. qu'est-ce qui existe déjà ?             → artifacts
 *   4. où vont les fichiers ?                  → destinations (portée projet)
 *
 * V1 : seuls les nœuds `database` et `volume` exposent une source cohérente.
 * Un conteneur n'a pas de volume de données identifié — on l'annonce au lieu
 * d'afficher un bouton qui échouerait côté API.
 */

function Section({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <section
      className="mt-4 flex flex-col gap-4 border-t border-ui-border-base pt-4"
      data-testid="backup-section"
    >
      <Heading level="h3" className="txt-compact-small-plus">
        {t("backup.title")}
      </Heading>
      {children}
    </section>
  )
}

/** Intitulé de groupe : petite capitale discrète + compteur optionnel. */
function GroupTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <Text size="xsmall" weight="plus" className="uppercase tracking-wide text-ui-fg-muted">
        {children}
      </Text>
      {typeof count === "number" && count > 0 && (
        <Text size="xsmall" className="tabular-nums text-ui-fg-subtle">
          {count}
        </Text>
      )}
    </div>
  )
}

function scheduleText(t: TFunction, policy: BackupPolicy): string {
  const key = `backup.policy.schedule${policy.schedule.charAt(0).toUpperCase()}${policy.schedule.slice(1)}`
  const base = t(key)
  return policy.scheduleHourUtc !== null ? `${base} · ${policy.scheduleHourUtc}:00 UTC` : base
}

/**
 * Bandeau d'état : répond en un coup d'œil à « ma base est-elle sauvegardée ? »
 * avant tout réglage. La planification n'est affichée que si elle existe.
 */
function BackupStatus({ latest, policies }: { latest?: BackupArtifact; policies: BackupPolicy[] }) {
  const { t, i18n } = useTranslation()
  const scheduled = policies.filter((policy) => policy.enabled && policy.schedule !== "manual")
  const schedule =
    policies.length === 0
      ? null
      : scheduled.length > 0
        ? t("backup.status.schedule", {
            value: scheduled.map((policy) => scheduleText(t, policy)).join(" · "),
          })
        : t("backup.status.manualOnly")

  return (
    <div
      className="rounded-lg border border-ui-border-base bg-ui-bg-subtle px-3 py-2.5"
      data-testid="backup-status"
    >
      <Text size="xsmall" weight="plus" className="text-ui-fg-subtle">
        {t("backup.status.last")}
      </Text>
      <Text size="small" className="mt-0.5 text-ui-fg-base">
        {latest
          ? `${formatDate(latest.committedAt, i18n.language)} · ${formatBytes(latest.sizeBytes)}`
          : t("backup.status.never")}
      </Text>
      {schedule && (
        <Text size="xsmall" className="mt-1 text-ui-fg-muted">
          {schedule}
        </Text>
      )}
    </div>
  )
}

function PolicyRuns({ policy }: { policy: BackupPolicy }) {
  const { t, i18n } = useTranslation()
  const runs = useQuery({
    queryKey: ["backup-runs", policy.id],
    queryFn: () => api.listBackupRuns(policy.id, 5),
  })
  const list = runs.data ?? []

  return (
    <div className="mt-2 min-h-[18px]" data-testid={`backup-runs-${policy.id}`}>
      {runs.isLoading ? (
        <Text size="xsmall" className="text-ui-fg-muted">
          {t("backup.loading")}
        </Text>
      ) : list.length === 0 ? (
        <Text size="xsmall" className="text-ui-fg-muted">
          {t("backup.run.empty")}
        </Text>
      ) : (
        <ul className="flex flex-col gap-1">
          {list.map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-2">
              <Text size="xsmall" className="text-ui-fg-subtle">
                {formatDate(run.startedAt, i18n.language)}
              </Text>
              <Text
                size="xsmall"
                className={
                  run.status === "FAILED"
                    ? "text-ui-fg-error"
                    : run.status === "RUNNING"
                      ? "text-ui-fg-muted"
                      : "text-ui-fg-interactive"
                }
              >
                {run.status === "FAILED"
                  ? t("backup.run.failed", { code: run.errorCode ?? "backup_failed" })
                  : run.status === "RUNNING"
                    ? t(`backup.phases.${run.phase}`)
                    : t("backup.run.statusCompleted")}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PolicyCard({
  policy,
  destinationName,
  onDeleted,
}: {
  policy: BackupPolicy
  destinationName: string
  onDeleted: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const prompt = usePrompt()

  const run = useMutation({
    mutationFn: () => api.runBackupPolicy(policy.id),
    onSuccess: () => {
      toast.success(t("backup.policy.run"))
      void qc.invalidateQueries({ queryKey: ["backup-runs", policy.id] })
      void qc.invalidateQueries({ queryKey: ["backup-artifacts"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: () => api.deleteBackupPolicy(policy.id),
    onSuccess: onDeleted,
    onError: (error: Error) => toast.error(error.message),
  })

  async function confirmRemove() {
    const ok = await prompt({
      title: t("backup.policy.delete"),
      description: `${policy.strategyId} → ${destinationName}`,
      confirmText: t("backup.policy.delete"),
      cancelText: t("backup.policy.cancel"),
      variant: "danger",
    })
    if (ok) remove.mutate()
  }

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-ui-border-base px-2.5 py-2"
      data-testid={`backup-policy-${policy.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <Text size="xsmall" weight="plus" className="truncate">
            {destinationName}
          </Text>
          <Text size="xsmall" className="text-ui-fg-muted">
            {scheduleText(t, policy)} ·{" "}
            {t("backup.policy.retentionValue", { days: policy.retentionDays })}
          </Text>
          <Text size="xsmall" className="truncate font-mono text-ui-fg-subtle">
            {policy.strategyId}
          </Text>
        </div>
        {policy.enabled ? (
          <Badge size="2xsmall" color="green" className="shrink-0">
            {t("backup.policy.enabled")}
          </Badge>
        ) : (
          <Badge size="2xsmall" color="grey" className="shrink-0">
            {t("backup.policy.disabled")}
          </Badge>
        )}
      </div>
      <div className="flex gap-1">
        <Button
          size="small"
          variant="secondary"
          isLoading={run.isPending}
          onClick={() => run.mutate()}
          data-testid={`backup-run-${policy.id}`}
          className="flex-1"
        >
          {run.isPending ? t("backup.policy.running") : t("backup.policy.run")}
        </Button>
        <Button
          size="small"
          variant="transparent"
          onClick={confirmRemove}
          aria-label={t("backup.policy.delete")}
          className="shrink-0 px-3"
        >
          ×
        </Button>
      </div>
      <PolicyRuns policy={policy} />
    </li>
  )
}

function TargetSection({ projectId, node }: { projectId: string; node: Node }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const [creatingPolicy, setCreatingPolicy] = useState(false)
  const [showDestinations, setShowDestinations] = useState(false)

  const targets = useQuery({
    queryKey: ["backup-targets", projectId],
    queryFn: () => api.listBackupTargets(projectId),
  })
  const target = targets.data?.find((item) => item.nodeId === node.id && !item.archived) ??
    targets.data?.find((item) => item.nodeId === node.id)

  const enable = useMutation({
    mutationFn: () => api.createBackupTarget(node.id),
    onSuccess: () => {
      toast.success(t("backup.enable"))
      void qc.invalidateQueries({ queryKey: ["backup-targets", projectId] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const policies = useQuery({
    queryKey: ["backup-policies", target?.id],
    queryFn: () => api.listBackupPolicies(target!.id),
    enabled: Boolean(target),
  })
  const artifacts = useQuery({
    queryKey: ["backup-artifacts", target?.id],
    queryFn: () => api.listBackupArtifacts(target!.id, 3),
    enabled: Boolean(target),
  })
  const destinations = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: api.listBackupDestinations,
    enabled: Boolean(target),
  })

  const destinationName = (id: string) =>
    (destinations.data ?? []).find((destination) => destination.id === id)?.name ?? id

  const refreshPolicies = () => {
    void qc.invalidateQueries({ queryKey: ["backup-policies", target?.id] })
  }

  if (targets.isLoading) {
    return (
      <Section>
        <Text size="xsmall" className="min-h-[44px] text-ui-fg-muted">
          {t("backup.loading")}
        </Text>
      </Section>
    )
  }

  if (targets.error) {
    return (
      <Section>
        <div className="flex min-h-[44px] flex-col items-start gap-2">
          <Text size="xsmall" className="text-ui-fg-error">
            {t("backup.error", { message: (targets.error as Error).message })}
          </Text>
          <Button size="small" variant="secondary" onClick={() => targets.refetch()}>
            {t("backup.retry")}
          </Button>
        </div>
      </Section>
    )
  }

  if (!target) {
    return (
      <Section>
        <div className="flex flex-col items-start gap-2">
          <Text size="xsmall" className="text-ui-fg-muted">
            {t("backup.empty")}
          </Text>
          <Text size="xsmall" className="text-ui-fg-subtle">
            {t("backup.emptyHint")}
          </Text>
          <Button
            size="small"
            variant="secondary"
            isLoading={enable.isPending}
            onClick={() => enable.mutate()}
            data-testid="backup-enable"
          >
            {t("backup.enable")}
          </Button>
        </div>
      </Section>
    )
  }

  const policyList = policies.data ?? []
  const latest = artifacts.data?.[0]
  // Une politique sans destination est un cul-de-sac : on ne propose l'ajout
  // que si le prérequis existe, sinon on pointe vers la création.
  const missingDestination = destinations.isSuccess && (destinations.data ?? []).length === 0

  return (
    <Section>
      <div className="flex items-center justify-between gap-2">
        <Text size="xsmall" className="text-ui-fg-muted">
          {t("backup.targetKind", { kind: target.kind })}
        </Text>
        <Badge size="2xsmall" color="green">
          {t("backup.active")}
        </Badge>
      </div>

      <BackupStatus latest={latest} policies={policyList} />

      <div className="flex flex-col gap-2">
        <GroupTitle count={policyList.length}>{t("backup.policy.count")}</GroupTitle>

        {creatingPolicy && (
          <BackupPolicyPanel
            target={target}
            onCreated={() => {
              setCreatingPolicy(false)
              refreshPolicies()
            }}
            onCancel={() => setCreatingPolicy(false)}
          />
        )}

        <div className="min-h-[44px]">
          {policies.isLoading ? (
            <Text size="xsmall" className="text-ui-fg-muted">
              {t("backup.loading")}
            </Text>
          ) : policyList.length === 0 ? (
            <Text size="xsmall" className="text-ui-fg-muted">
              {t("backup.policy.empty")}
            </Text>
          ) : (
            <ul className="flex flex-col gap-1.5" data-testid="backup-policies">
              {policyList.map((policy) => (
                <PolicyCard
                  key={policy.id}
                  policy={policy}
                  destinationName={destinationName(policy.destinationId)}
                  onDeleted={refreshPolicies}
                />
              ))}
            </ul>
          )}
        </div>

        {!creatingPolicy &&
          (missingDestination ? (
            <Text size="xsmall" className="text-ui-fg-muted">
              {t("backup.destinations.required")}
            </Text>
          ) : (
            <Button
              size="small"
              variant="secondary"
              className="self-start"
              onClick={() => setCreatingPolicy(true)}
            >
              {t("backup.policy.create")}
            </Button>
          ))}
      </div>

      <div className="flex flex-col gap-1.5" data-testid="backup-artifacts">
        <GroupTitle>{t("backup.artifact.title")}</GroupTitle>
        {artifacts.isLoading ? (
          <Text size="xsmall" className="min-h-[44px] text-ui-fg-muted">
            {t("backup.loading")}
          </Text>
        ) : !latest ? (
          <Text size="xsmall" className="min-h-[44px] text-ui-fg-muted">
            {t("backup.artifact.empty")}
          </Text>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {(artifacts.data ?? []).map((artifact) => (
              <li key={artifact.id} className="flex flex-col">
                <Text size="xsmall" className="text-ui-fg-base">
                  {formatDate(artifact.committedAt, i18n.language)} ·{" "}
                  {formatBytes(artifact.sizeBytes)}
                </Text>
                <Text size="xsmall" className="truncate font-mono text-ui-fg-subtle">
                  {artifact.payloadFormat} · {shortChecksum(artifact.checksumSha256)}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Destinations : portée projet, repliées pour ne pas concurrencer le
          réglage du nœud courant. */}
      <div className="flex flex-col gap-1.5 border-t border-ui-border-base pt-3">
        <button
          type="button"
          aria-expanded={showDestinations}
          onClick={() => setShowDestinations((value) => !value)}
          className="flex w-full items-center justify-between gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-ui-bg-subtle"
        >
          <span className="txt-compact-xsmall-plus uppercase tracking-wide text-ui-fg-muted">
            {t("backup.destinations.title")}
          </span>
          <span aria-hidden="true" className="txt-compact-xsmall text-ui-fg-subtle">
            {showDestinations ? "▾" : "▸"}
          </span>
        </button>
        <Text size="xsmall" className="px-1 text-ui-fg-subtle">
          {t("backup.destinations.projectWide")}
        </Text>
        {showDestinations && <BackupDestinationPanel projectId={projectId} />}
      </div>
    </Section>
  )
}

export function BackupSection({ projectId, node }: { projectId: string; node: Node }) {
  const { t } = useTranslation()
  if (node.type === "container") {
    return (
      <Section>
        <Text size="xsmall" className="min-h-[44px] text-ui-fg-muted">
          {t("backup.unavailable")}
        </Text>
      </Section>
    )
  }
  if (node.type !== "database" && node.type !== "volume") return null
  return <TargetSection projectId={projectId} node={node} />
}
