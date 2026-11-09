import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Button,
  Heading,
  Input,
  Label,
  Select,
  Switch,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import {
  BACKUP_DESTINATION_FIELD_SPECS,
  BackupDestinationFieldsSchema,
  BackupProtocolSchema,
  type BackupDestinationFields,
  type BackupProtocol,
} from "@hullbay/shared/backup"
import { api, type BackupCapabilities, type BackupProbeResult } from "../../lib/api"
import { useMe } from "../../lib/useMe"
import { formatDate } from "./format"

type FieldValue = string | number | boolean

const PROTOCOLS = BackupProtocolSchema.options

function initialFields(protocol: BackupProtocol): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {}
  for (const spec of BACKUP_DESTINATION_FIELD_SPECS[protocol]) {
    values[spec.key] =
      spec.defaultValue ?? (spec.type === "boolean" ? false : spec.type === "number" ? "" : "")
  }
  return values
}

/** Construit la config typée à partir des valeurs du formulaire. */
function toConfig(
  protocol: BackupProtocol,
  values: Record<string, FieldValue>,
): Record<string, unknown> {
  const config: Record<string, unknown> = { protocol }
  for (const spec of BACKUP_DESTINATION_FIELD_SPECS[protocol]) {
    const raw = values[spec.key]
    if (spec.type === "boolean") {
      config[spec.key] = Boolean(raw)
      continue
    }
    if (spec.type === "number") {
      if (raw === "" || raw === undefined) continue
      config[spec.key] = Number(raw)
      continue
    }
    if (typeof raw === "string" && raw.trim() === "") continue
    config[spec.key] = raw
  }
  return config
}

function CapabilityRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Text size="xsmall" className="text-ui-fg-subtle">
        {label}
      </Text>
      <Text
        size="xsmall"
        weight="plus"
        className={ok ? "text-ui-fg-interactive" : "text-ui-fg-error"}
        aria-label={`${label}: ${ok ? "ok" : "ko"}`}
      >
        {ok ? "✓" : "✗"}
      </Text>
    </div>
  )
}

export function CapabilityMatrix({ capabilities }: { capabilities: BackupCapabilities }) {
  const { t } = useTranslation()
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1" data-testid="backup-capabilities">
      <CapabilityRow ok={capabilities.read} label={t("backup.destinations.capRead")} />
      <CapabilityRow ok={capabilities.write} label={t("backup.destinations.capWrite")} />
      <CapabilityRow ok={capabilities.delete} label={t("backup.destinations.capDelete")} />
      <CapabilityRow ok={capabilities.move} label={t("backup.destinations.capMove")} />
      <CapabilityRow ok={capabilities.checksum} label={t("backup.destinations.capChecksum")} />
      <CapabilityRow ok={capabilities.atomicCommit} label={t("backup.destinations.capCommit")} />
    </div>
  )
}

/**
 * Gestion des destinations de sauvegarde (owner).
 *
 * Les valeurs secrètes ne sont JAMAIS relues depuis l'API : le formulaire est
 * vierge à chaque ouverture et n'est persisté que côté serveur (chiffré). Un
 * operator voit la liste en lecture seule, sans pouvoir muter ni tester.
 */
export function BackupDestinationPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation()
  const { can } = useMe()
  const isOwner = can("owner")
  const qc = useQueryClient()

  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [basePath, setBasePath] = useState("hullbay/backups")
  const [protocol, setProtocol] = useState<BackupProtocol>("s3")
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    initialFields("s3"),
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, BackupProbeResult>>({})

  const destinations = useQuery({
    queryKey: ["backup-destinations"],
    queryFn: api.listBackupDestinations,
  })

  const create = useMutation({
    mutationFn: async () => {
      const parsed = BackupDestinationFieldsSchema.safeParse(toConfig(protocol, values))
      if (!parsed.success) {
        throw new Error(
          parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
            .join(" · "),
        )
      }
      return api.createBackupDestination({
        name: name.trim(),
        basePath: basePath.trim(),
        projectId,
        config: parsed.data as BackupDestinationFields,
      })
    },
    onSuccess: () => {
      setOpen(false)
      setName("")
      setValues(initialFields(protocol))
      setFormError(null)
      toast.success(t("backup.destinations.create"))
      void qc.invalidateQueries({ queryKey: ["backup-destinations"] })
    },
    onError: (error: Error) => setFormError(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteBackupDestination(id),
    onSuccess: () => {
      toast.success(t("backup.destinations.title"))
      void qc.invalidateQueries({ queryKey: ["backup-destinations"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const test = useMutation({
    mutationFn: (id: string) => api.testBackupDestination(id),
    onSuccess: (result, id) => {
      setProbes((prev) => ({ ...prev, [id]: result }))
      void qc.invalidateQueries({ queryKey: ["backup-destinations"] })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  function changeProtocol(next: BackupProtocol) {
    setProtocol(next)
    setValues(initialFields(next))
    setFormError(null)
  }

  const list = destinations.data ?? []

  return (
    <section className="flex flex-col gap-2" data-testid="backup-destinations">
      <div className="flex items-center justify-between">
        <Heading level="h3" className="txt-compact-small">
          {t("backup.destinations.title")}
        </Heading>
        {isOwner && (
          <Button
            size="small"
            variant="transparent"
            onClick={() => {
              setOpen((v) => !v)
              setFormError(null)
            }}
          >
            {open ? t("backup.destinations.cancel") : t("backup.destinations.add")}
          </Button>
        )}
      </div>

      {!isOwner && (
        <Text size="xsmall" className="text-ui-fg-muted">
          {t("backup.destinations.ownerOnly")}
        </Text>
      )}

      {open && isOwner && (
        <form
          className="flex flex-col gap-2 rounded-md border border-ui-border-base p-2.5"
          data-testid="backup-destination-form"
          onSubmit={(event) => {
            event.preventDefault()
            setFormError(null)
            if (!name.trim() || !basePath.trim()) {
              setFormError(t("backup.destinations.name"))
              return
            }
            create.mutate()
          }}
        >
          <div>
            <Label size="small">{t("backup.destinations.name")}</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="backup-destination-name"
            />
          </div>
          <div>
            <Label size="small">{t("backup.destinations.basePath")}</Label>
            <Input
              value={basePath}
              onChange={(event) => setBasePath(event.target.value)}
              placeholder="hullbay/backups"
            />
            <Text size="xsmall" className="mt-1 text-ui-fg-muted">
              {t("backup.destinations.basePathHint")}
            </Text>
          </div>
          <div>
            <Label size="small">{t("backup.destinations.protocol")}</Label>
            <Select
              value={protocol}
              onValueChange={(value) => changeProtocol(value as BackupProtocol)}
            >
              <Select.Trigger data-testid="backup-protocol-select">
                <Select.Value />
              </Select.Trigger>
              <Select.Content className="z-[60]">
                {PROTOCOLS.map((value) => (
                  <Select.Item key={value} value={value}>
                    {value}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          {BACKUP_DESTINATION_FIELD_SPECS[protocol].map((spec) => {
            const label = t(`backup.fields.${spec.key}`)
            const optional = spec.required ? "" : ` (${t("backup.fields.optional")})`
            if (spec.type === "boolean") {
              return (
                <div key={spec.key} className="flex items-center justify-between">
                  <Label size="small">{label}</Label>
                  <Switch
                    checked={Boolean(values[spec.key])}
                    onCheckedChange={(checked) =>
                      setValues((prev) => ({ ...prev, [spec.key]: checked }))
                    }
                    data-testid={`backup-field-${spec.key}`}
                  />
                </div>
              )
            }
            if (spec.type === "textarea") {
              return (
                <div key={spec.key}>
                  <Label size="small">
                    {label}
                    {optional}
                  </Label>
                  <Textarea
                    value={String(values[spec.key] ?? "")}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [spec.key]: event.target.value }))
                    }
                    data-testid={`backup-field-${spec.key}`}
                    rows={3}
                  />
                </div>
              )
            }
            return (
              <div key={spec.key}>
                <Label size="small">
                  {label}
                  {optional}
                </Label>
                <Input
                  type={spec.type === "password" ? "password" : spec.type === "number" ? "number" : "text"}
                  autoComplete={spec.type === "password" ? "new-password" : "off"}
                  value={String(values[spec.key] ?? "")}
                  onChange={(event) =>
                    setValues((prev) => ({ ...prev, [spec.key]: event.target.value }))
                  }
                  data-testid={`backup-field-${spec.key}`}
                />
              </div>
            )
          })}

          {formError && (
            <Text size="xsmall" className="text-ui-fg-error" role="alert">
              {formError}
            </Text>
          )}
          <Button type="submit" size="small" isLoading={create.isPending}>
            {create.isPending ? t("backup.destinations.creating") : t("backup.destinations.create")}
          </Button>
        </form>
      )}

      {destinations.isLoading ? (
        <Text size="xsmall" className="min-h-[20px] text-ui-fg-muted">
          {t("backup.loading")}
        </Text>
      ) : list.length === 0 ? (
        <Text size="xsmall" className="min-h-[20px] text-ui-fg-muted">
          {t("backup.destinations.empty")}
        </Text>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map((destination) => {
            const probe = probes[destination.id]
            const capabilities = probe?.capabilities ?? destination.capabilities
            return (
              <li
                key={destination.id}
                className="rounded-md border border-ui-border-base px-2.5 py-2"
                data-testid={`backup-destination-${destination.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <Text size="xsmall" weight="plus" className="truncate">
                      {destination.name}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {destination.protocol} · {destination.basePath}
                    </Text>
                  </div>
                  {isOwner && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="small"
                        variant="secondary"
                        isLoading={test.isPending && test.variables === destination.id}
                        onClick={() => test.mutate(destination.id)}
                        data-testid={`backup-test-${destination.id}`}
                      >
                        {test.isPending && test.variables === destination.id
                          ? t("backup.destinations.testing")
                          : t("backup.destinations.test")}
                      </Button>
                      <Button
                        size="small"
                        variant="transparent"
                        onClick={() => remove.mutate(destination.id)}
                        aria-label={t("backup.destinations.cancel")}
                      >
                        ×
                      </Button>
                    </div>
                  )}
                </div>
                <Text size="xsmall" className="mt-1 text-ui-fg-subtle">
                  {destination.lastTestedAt
                    ? t("backup.destinations.lastTested", {
                        date: formatDate(destination.lastTestedAt, i18n.language),
                      })
                    : t("backup.destinations.neverTested")}
                </Text>
                {capabilities && <CapabilityMatrix capabilities={capabilities} />}
                {probe && (
                  <Text
                    size="xsmall"
                    className={probe.ok ? "mt-1 text-ui-fg-interactive" : "mt-1 text-ui-fg-error"}
                  >
                    {probe.ok ? t("backup.destinations.probeOk") : t("backup.destinations.probeKo")}
                  </Text>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
