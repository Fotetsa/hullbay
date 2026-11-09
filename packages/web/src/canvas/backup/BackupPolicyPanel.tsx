import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Button, Input, Label, Select, Text, Textarea, toast } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import {
  BACKUP_STRATEGY_BY_KIND,
  BackupPolicyInputSchema,
  type BackupPolicyInput,
  type BackupSchedule,
} from "@hullbay/shared/backup"
import { api, type BackupTarget } from "../../lib/api"

const SCHEDULES: BackupSchedule[] = ["manual", "daily", "weekly"]

/**
 * Création d'une policy : la stratégie est IMPOSÉE par le type de cible
 * (aucun choix exposé), et le placement devient obligatoire dès que la
 * destination est SMB — le NAS n'est pas joignable depuis tous les nœuds.
 */
export function BackupPolicyPanel({
  target,
  onCreated,
  onCancel,
}: {
  target: BackupTarget
  onCreated: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const destinations = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: api.listBackupDestinations,
  })

  const [destinationId, setDestinationId] = useState("")
  const [schedule, setSchedule] = useState<BackupSchedule>("manual")
  const [hour, setHour] = useState(3)
  const [retentionDays, setRetentionDays] = useState(30)
  const [verification, setVerification] = useState<"size" | "checksum">("checksum")
  const [timeoutSec, setTimeoutSec] = useState(1800)
  const [constraints, setConstraints] = useState("")
  const [error, setError] = useState<string | null>(null)

  const destination = (destinations.data ?? []).find((d) => d.id === destinationId)
  const isSmb = destination?.protocol === "smb"
  const placementLines = constraints
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const create = useMutation({
    mutationFn: async () => {
      if (!destinationId) throw new Error(t("backup.policy.destination"))
      if (isSmb && placementLines.length === 0) {
        throw new Error(t("backup.policy.placementRequired"))
      }
      const input: BackupPolicyInput = {
        targetId: target.id,
        destinationId,
        strategyId: BACKUP_STRATEGY_BY_KIND[target.kind],
        schedule,
        ...(schedule === "manual" ? {} : { scheduleHourUtc: hour }),
        retentionDays,
        verification,
        encryptionMode: "none",
        ...(placementLines.length
          ? { placement: { constraints: placementLines, spreadOver: [] } }
          : {}),
        timeoutSec,
        maxConcurrency: 1,
        enabled: true,
      }
      const parsed = BackupPolicyInputSchema.safeParse(input)
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`)
            .join(" · "),
        )
      }
      return api.createBackupPolicy(parsed.data)
    },
    onSuccess: () => {
      toast.success(t("backup.policy.create"))
      onCreated()
    },
    onError: (mutationError: Error) => setError(mutationError.message),
  })

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-ui-border-base p-2.5"
      data-testid="backup-policy-form"
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        create.mutate()
      }}
    >
      <div>
        <Label size="small">{t("backup.policy.strategy")}</Label>
        <Text size="xsmall" className="font-mono text-ui-fg-muted">
          {BACKUP_STRATEGY_BY_KIND[target.kind]}
        </Text>
        <Text size="xsmall" className="mt-1 text-ui-fg-muted">
          {target.kind === "volume"
            ? t("backup.policy.volumeOnly")
            : t("backup.policy.nativeOnly")}
        </Text>
      </div>

      <div>
        <Label size="small">{t("backup.policy.destination")}</Label>
        <Select value={destinationId} onValueChange={setDestinationId}>
          <Select.Trigger data-testid="backup-policy-destination">
            <Select.Value placeholder={t("backup.policy.destination")} />
          </Select.Trigger>
          <Select.Content className="z-[60]">
            {(destinations.data ?? []).map((item) => (
              <Select.Item key={item.id} value={item.id}>
                {item.name} ({item.protocol})
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
        {destinations.isLoading && (
          <Text size="xsmall" className="mt-1 min-h-[16px] text-ui-fg-muted">
            {t("backup.loading")}
          </Text>
        )}
      </div>

      <div>
        <Label size="small">{t("backup.policy.schedule")}</Label>
        <Select value={schedule} onValueChange={(value) => setSchedule(value as BackupSchedule)}>
          <Select.Trigger data-testid="backup-policy-schedule">
            <Select.Value />
          </Select.Trigger>
          <Select.Content className="z-[60]">
            {SCHEDULES.map((value) => (
              <Select.Item key={value} value={value}>
                {t(`backup.policy.schedule${value.charAt(0).toUpperCase()}${value.slice(1)}`)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>

      {schedule !== "manual" && (
        <div>
          <Label size="small">{t("backup.policy.hourUtc")}</Label>
          <Input
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={(event) => setHour(Number(event.target.value))}
          />
        </div>
      )}

      <div>
        <Label size="small">{t("backup.policy.retention")}</Label>
        <Input
          type="number"
          min={1}
          max={3650}
          value={retentionDays}
          onChange={(event) => setRetentionDays(Number(event.target.value))}
        />
        <Text size="xsmall" className="mt-1 text-ui-fg-muted">
          {t("backup.policy.retentionHint")}
        </Text>
      </div>

      <div>
        <Label size="small">{t("backup.policy.verification")}</Label>
        <Select
          value={verification}
          onValueChange={(value) => setVerification(value as "size" | "checksum")}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content className="z-[60]">
            <Select.Item value="checksum">{t("backup.policy.verificationChecksum")}</Select.Item>
            <Select.Item value="size">{t("backup.policy.verificationSize")}</Select.Item>
          </Select.Content>
        </Select>
      </div>

      <div>
        <Label size="small">{t("backup.policy.timeout")}</Label>
        <Input
          type="number"
          min={60}
          max={86400}
          value={timeoutSec}
          onChange={(event) => setTimeoutSec(Number(event.target.value))}
        />
      </div>

      <div>
        <Label size="small">{t("backup.policy.placement")}</Label>
        <Textarea
          rows={2}
          value={constraints}
          onChange={(event) => setConstraints(event.target.value)}
          data-testid="backup-policy-placement"
          placeholder="node.labels.zone == nas"
        />
        <Text
          size="xsmall"
          className={isSmb && placementLines.length === 0 ? "mt-1 text-ui-fg-error" : "mt-1 text-ui-fg-muted"}
        >
          {t("backup.policy.placementHint")}
        </Text>
      </div>

      {error && (
        <Text size="xsmall" className="text-ui-fg-error" role="alert">
          {error}
        </Text>
      )}

      <div className="flex justify-end gap-1">
        <Button type="button" size="small" variant="secondary" onClick={onCancel}>
          {t("backup.policy.cancel")}
        </Button>
        <Button type="submit" size="small" isLoading={create.isPending}>
          {create.isPending ? t("backup.policy.creating") : t("backup.policy.create")}
        </Button>
      </div>
    </form>
  )
}
