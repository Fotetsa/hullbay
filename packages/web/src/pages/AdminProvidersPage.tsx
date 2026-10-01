import { useRef, useState, type ChangeEvent } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import {
  Badge,
  Button,
  FocusModal,
  Heading,
  Input,
  Label,
  Select,
  Tabs,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui"
import {
  Beaker,
  CheckCircle,
  ChevronRightMini,
  PencilSquare,
  Plus,
  ShieldCheck,
  Trash,
  DocumentText,
  XCircle,
} from "@medusajs/icons"
import { useTranslation } from "react-i18next"
import { Navigate } from "react-router-dom"
import {
  api,
  type ApiError,
  type AuthProviderAdmin,
  type AuthProviderPreflightResult,
  type AuthProviderUpsert,
  type PendingIdentity,
  SECRET_MASK,
} from "../lib/api"
import { useMe } from "../lib/useMe"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { PageContainer, PageHeader } from "../components/PageHeader"
import { ModalForm } from "../components/ModalForm"
import { ToggleSwitch } from "../components/ToggleSwitch"
import { Stepper } from "../components/Stepper"
import { ProviderDetailDrawer } from "../components/ProviderDetailDrawer"

type Kind = "oidc" | "oauth2" | "saml" | "ldap"

const KINDS: Kind[] = ["oidc", "oauth2", "saml", "ldap"]

type BadgeColor = "green" | "red" | "blue" | "orange" | "purple" | "grey"

const KIND_BADGE: Record<string, { color: BadgeColor; icon: string }> = {
  oidc: { color: "blue", icon: "OIDC" },
  oauth2: { color: "purple", icon: "OAuth2" },
  saml: { color: "orange", icon: "SAML" },
  local: { color: "grey", icon: "Local" },
  ldap: { color: "green", icon: "LDAP" },
}

/** Protocoles dont la config est éditable/testable via l'API (cf. backend kindToSchema). */
const isManagedKind = (kind: string): kind is Kind => (KINDS as string[]).includes(kind)

/** Champs de config d'un kind ; vide si le protocole n'est pas géré par l'API. */
const fieldsFor = (kind: string): FieldDef[] => (isManagedKind(kind) ? CONFIG_FIELDS[kind] : [])

/** Clés gérées par le serveur (redirect/callback/discovery/spIssuer) :
 *  non envoyées à la création — le backend les résout lui-même. */
const managedKeysFor = (kind: string): string[] =>
  fieldsFor(kind).filter((f) => f.managed).map((f) => f.key)

/** Normalise la config avant envoi : champs numériques → nombre (champ vide
 *  retiré, sinon zod number refuserait), clés managed omises si vide. */
function normalizeConfig(fields: FieldDef[], config: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = config[f.key]
    if (f.inputType === "number") {
      const n = raw === undefined || raw === "" ? NaN : Number(raw)
      if (Number.isFinite(n)) normalized[f.key] = n
    } else if (!f.managed || String(raw ?? "").trim() !== "") {
      normalized[f.key] = raw
    }
  }
  return normalized
}

const omitManagedKeys = (
  config: Record<string, unknown>,
  kind: string,
): Record<string, unknown> => {
  const managedKeys = managedKeysFor(kind)
  return Object.fromEntries(Object.entries(config).filter(([k]) => !managedKeys.includes(k)))
}

type FieldDef = {
  key: string
  labelKey: string
  required?: boolean
  inputType?: "text" | "url" | "password" | "number" | "textarea"
  /** Borne serveur (zod) — miroir côté client pour un refus immédiat. */
  min?: number
  max?: number
  /** Champs gérés par Hullbay (redirect/callback/discovery/spIssuer) :
   *  non obligatoires, remplis automatiquement si absents. */
  managed?: boolean
  /** Permet d'importer le contenu depuis un fichier (.pem…). */
  fileUpload?: boolean
}

const CONFIG_FIELDS: Record<Kind, FieldDef[]> = {
  oidc: [
    { key: "issuer", labelKey: "field.issuer", required: true, inputType: "url" },
    { key: "clientId", labelKey: "field.clientId", required: true },
    { key: "clientSecret", labelKey: "field.clientSecret", inputType: "password" },
    { key: "redirectUri", labelKey: "field.redirectUri", inputType: "url", managed: true },
    { key: "scopes", labelKey: "field.scopes" },
    { key: "discoveryUrl", labelKey: "field.discoveryUrl", inputType: "url", managed: true },
    { key: "jwksUri", labelKey: "field.jwksUri", inputType: "url" },
    { key: "acceptedClockSkewMs", labelKey: "field.acceptedClockSkewMs", inputType: "number", min: 1, max: 300000 },
  ],
  oauth2: [
    { key: "authorizationUri", labelKey: "field.authorizationUri", required: true, inputType: "url" },
    { key: "tokenUri", labelKey: "field.tokenUri", required: true, inputType: "url" },
    { key: "userinfoUri", labelKey: "field.userinfoUri", required: true, inputType: "url" },
    { key: "clientId", labelKey: "field.clientId", required: true },
    { key: "clientSecret", labelKey: "field.clientSecret", inputType: "password" },
    { key: "redirectUri", labelKey: "field.redirectUri", inputType: "url", managed: true },
    { key: "scopes", labelKey: "field.scopes" },
    { key: "groupAttr", labelKey: "field.groupAttr" },
  ],
  saml: [
    { key: "idpCert", labelKey: "field.idpCert", required: true, inputType: "textarea", fileUpload: true },
    { key: "idpIssuer", labelKey: "field.idpIssuer", required: true },
    { key: "spIssuer", labelKey: "field.spIssuer", managed: true },
    { key: "entryPoint", labelKey: "field.entryPoint", required: true, inputType: "url" },
    { key: "callbackUrl", labelKey: "field.callbackUrl", inputType: "url", managed: true },
    { key: "audience", labelKey: "field.audience" },
    { key: "acceptedClockSkewMs", labelKey: "field.acceptedClockSkewMs", inputType: "number", min: 1, max: 300000 },
  ],
  ldap: [
    { key: "url", labelKey: "field.ldapUrl", required: true },
    { key: "bindDn", labelKey: "field.bindDn" },
    { key: "bindSecret", labelKey: "field.bindSecret", inputType: "password" },
    { key: "searchBase", labelKey: "field.searchBase", required: true },
    { key: "searchFilter", labelKey: "field.searchFilter", required: true },
    { key: "stableAttr", labelKey: "field.stableAttr", required: true },
    { key: "groupSearchBase", labelKey: "field.groupSearchBase" },
    { key: "groupFilter", labelKey: "field.groupFilter" },
    { key: "timeoutMs", labelKey: "field.timeoutMs", inputType: "number", min: 1, max: 60000 },
  ],
}

/**
 * Aperçu, côté écran, des champs gérés par le serveur (override possible via PUT).
 * Miroir du backend (provider-auto-config.ts) : chemin de callback par kind.
 */
function managedPreview(kind: string, draftId: string, key: string, config: Record<string, unknown>): string | null {
  const base = typeof window !== "undefined" ? window.location.origin : ""
  if (!base) return null
  if (key === "redirectUri") return `${base}/api/auth/sso/${draftId}/callback`
  if (key === "spIssuer") return `${base}/api/auth/saml/${draftId}/metadata`
  if (key === "callbackUrl") return `${base}/api/auth/saml/${draftId}/acs`
  if (key === "discoveryUrl") {
    const issuer = typeof config.issuer === "string" ? config.issuer : ""
    if (!issuer) return null
    return `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
  }
  return null
}

type Draft = {
  kind: string
  name: string
  id: string
  enabled: boolean
  config: Record<string, string | number>
}

function emptyDraft(): Draft {
  return { kind: "oidc", name: "", id: "", enabled: false, config: {} }
}

function draftFrom(provider: AuthProviderAdmin): Draft {
  return {
    kind: provider.kind,
    name: provider.name,
    id: provider.id,
    enabled: provider.enabled,
    config: provider.config as Record<string, string | number>,
  }
}

/**
 * Page d'administration de l'authentification (owner uniquement).
 * Onglet Providers : CRUD des providers SSO (OIDC/OAuth2/SAML) + test de
 * connexion ; onglet Pendings : approbation des identités externes par tenant.
 *
 * Design : tab pills custom (Updates page pattern) + cards en bordure arrondie.
 */
export function AdminProvidersPage() {
  const { t } = useTranslation()
  const { me, can } = useMe()

  const [activeTab, setActiveTab] = useState<"providers" | "pendings">("providers")

  const providers = useQuery({
    queryKey: ["admin", "providers"],
    queryFn: api.listAdminProviders,
    enabled: can("owner"),
  })
  const pendings = useQuery({
    queryKey: ["admin", "pendings"],
    queryFn: api.listAdminPendings,
    enabled: can("owner"),
  })
  const tenants = useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: api.listTenants,
    enabled: can("owner"),
  })

  // ── Providers : modal create/edit ──────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AuthProviderAdmin | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  // Détail latéral read-only (pattern « liaison database »).
  const [detail, setDetail] = useState<AuthProviderAdmin | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  // Wizard de création : étape config → étape vérification (prévol live).
  const [createStep, setCreateStep] = useState(0)
  const [preflight, setPreflight] = useState<AuthProviderPreflightResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingFileKey, setPendingFileKey] = useState<string | null>(null)

  const setField = (key: string, value: string | number) =>
    setDraft((d) => ({ ...d, config: { ...d.config, [key]: value } }))

  const openCreate = () => {
    setEditing(null)
    setDraft(emptyDraft())
    setCreateStep(0)
    setPreflight(null)
    setModalOpen(true)
  }
  const openEdit = (provider: AuthProviderAdmin) => {
    setEditing(provider)
    setDraft(draftFrom(provider))
    setCreateStep(0)
    setPreflight(null)
    setModalOpen(true)
  }
  const closeModal = () => {
    setModalOpen(false)
    setEditing(null)
  }
  const openDetail = (provider: AuthProviderAdmin) => {
    setDetail(provider)
    setDetailOpen(true)
  }

  // Prévol (étape 2 du wizard) : valide + sonde la config SANS la persister.
  const preflightMut = useMutation({
    mutationFn: async () => {
      if (!isManagedKind(draft.kind)) return null
      const normalized = normalizeConfig(fieldsFor(draft.kind), draft.config)
      return api.preflightAdminProvider(draft.kind, normalized)
    },
    onSuccess: (r) => setPreflight(r),
    onError: () => setPreflight({ ok: false, schemaValid: false, steps: [], details: undefined }),
  })

  // Import d'un fichier .pem (certificat SAML…) : contenu placé dans le champ.
  const onFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !pendingFileKey) return
    void file.text().then((content) => setField(pendingFileKey, content.trim()))
    e.target.value = ""
    setPendingFileKey(null)
  }

  // ── Validation par tranche du wizard ─────────────────────────────────
  const basicValid = (): boolean => {
    if (draft.name.trim() === "") return false
    if (!editing && !/^[a-z0-9-]{3,64}$/.test(draft.id.trim())) return false
    return true
  }
  const configValid = (): boolean => {
    const missing = fieldsFor(draft.kind).some(
      (f) => !f.managed && f.required && String(draft.config[f.key] ?? "").trim() === "",
    )
    if (missing) return false
    // Bornes miroir du serveur (zod) — refus immédiat plutôt que 400 tardif.
    return !fieldsFor(draft.kind).some((f) => {
      if (f.min === undefined && f.max === undefined) return false
      const raw = draft.config[f.key]
      if (raw === undefined || raw === "") return false
      const n = Number(raw)
      return !Number.isFinite(n) || n < (f.min ?? -Infinity) || n > (f.max ?? Infinity)
    })
  }
  const canSave = (): boolean => basicValid() && configValid()

  const submit = () => {
    if (!canSave()) {
      toast.error(t("providers.form.requiredErrs"))
      return
    }
    save.mutate()
  }

  /** Le wizard avance d'une étape, chaque étape ne valide que sa tranche.
   *  À l'entrée de la Vérification (étape 3), la prévol est lancée
   *  (elle sonde la config sans la persister). */
  const goToNextStep = () => {
    if (createStep === 0) {
      if (!basicValid()) {
        toast.error(t("providers.form.requiredErrs"))
        return
      }
      setCreateStep(1)
      return
    }
    if (createStep === 1) {
      if (!configValid()) {
        toast.error(t("providers.form.requiredErrs"))
        return
      }
      setCreateStep(2)
      void preflightMut.mutateAsync()
      return
    }
    submit()
  }

  const onSubmitModal = () => {
    if (!editing && createStep < 2) goToNextStep()
    else submit()
  }

  // ── Sous-rendus du wizard : chaque étape ne montre que sa tranche,
  // ── jamais le formulaire entier. ─────────────────────────────────────
  const renderIdentityFields = (withEnabled: boolean) => (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <Label size="small">{t("providers.form.kindLabel")}</Label>
        <Select
          value={draft.kind}
          onValueChange={(v) => {
            setDraft((d) => ({ ...d, kind: v, config: {} }))
            setPreflight(null)
          }}
          disabled={!!editing}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {(isManagedKind(draft.kind) ? KINDS : [...KINDS, draft.kind]).map((k) => (
              <Select.Item key={k} value={k}>
                {t(`providers.form.kind${k[0].toUpperCase()}${k.slice(1)}`)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <div>
        <Label size="small">{t("providers.form.nameLabel")}</Label>
        <Input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder={t("providers.form.namePlaceholder")}
        />
      </div>
      {!editing && (
        <div>
          <Label size="small">{t("providers.form.idLabel")}</Label>
          <Input
            value={draft.id}
            onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
            placeholder={t("providers.form.idPlaceholder")}
          />
          <Text size="xsmall" className="mt-1 text-ui-fg-muted">
            {t("providers.form.idHint")}
          </Text>
        </div>
      )}
      {withEnabled && (
        <div className="flex items-center gap-2 pt-4">
          <ToggleSwitch
            checked={draft.enabled}
            onCheckedChange={(checked) => setDraft((d) => ({ ...d, enabled: checked }))}
            aria-label={t("providers.form.enabledLabel")}
          />
          <div>
            <Text weight="plus" size="small">
              {t("providers.form.enabledLabel")}
            </Text>
            <Text size="xsmall" className="text-ui-fg-muted">
              {t("providers.form.enabledHint")}
            </Text>
          </div>
        </div>
      )}
    </div>
  )

  const renderConfigFields = () => (
    <div>
      <Label size="small">{t("providers.form.configLabel")}</Label>
      {fieldsFor(draft.kind).length === 0 ? (
        <Text size="xsmall" className="mt-2 block text-ui-fg-muted">
          {t("providers.form.configUnsupported")}
        </Text>
      ) : (
        <>
          {fieldsFor(draft.kind).map((field) => {
            const value = draft.config[field.key]
            const raw = value === undefined ? "" : String(value)
            const preview = field.managed
              ? managedPreview(draft.kind, draft.id.trim(), field.key, draft.config)
              : null
            return (
              <div key={field.key} className="mt-3">
                <Label size="small">
                  {t(`providers.${field.labelKey}`)}
                  {field.required && <span className="text-ui-fg-error"> *</span>}
                </Label>
                {field.managed && !editing ? (
                  /* Champ géré par Hullbay : aperçu read-only à la création —
                     le backend le résout via la base publique. */
                  <div className="mt-1 rounded-lg border border-dashed border-ui-border-base bg-ui-bg-subtle px-3 py-2">
                    <Text size="xsmall" className="font-mono text-ui-fg-base">
                      {preview ?? "—"}
                    </Text>
                    <Text size="xsmall" className="mt-0.5 text-ui-fg-muted">
                      {t("providers.wizard.managedHint")}
                    </Text>
                  </div>
                ) : field.inputType === "textarea" ? (
                  <>
                    <Textarea
                      value={raw}
                      onChange={(e) => setField(field.key, e.target.value)}
                      rows={4}
                      className="mt-1 font-mono"
                    />
                    {field.fileUpload && (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".pem,.crt,.cer,.der,.txt"
                          className="hidden"
                          aria-hidden="true"
                          onChange={onFilePicked}
                        />
                        <Button
                          variant="secondary"
                          size="small"
                          type="button"
                          className="mt-2"
                          onClick={() => {
                            setPendingFileKey(field.key)
                            fileInputRef.current?.click()
                          }}
                        >
                          <DocumentText />
                          {t("providers.wizard.importPem")}
                        </Button>
                      </>
                    )}
                  </>
                ) : (
                  <Input
                    type={
                      field.inputType === "password"
                        ? "password"
                        : field.inputType === "number"
                          ? "number"
                          : field.inputType === "url"
                            ? "url"
                            : "text"
                    }
                    min={field.min}
                    max={field.max}
                    step={field.inputType === "number" ? 1 : undefined}
                    inputMode={field.inputType === "number" ? "numeric" : undefined}
                    value={raw}
                    onChange={(e) => setField(field.key, e.target.value)}
                    className="mt-1"
                  />
                )}
                {field.managed && editing && preview && raw === "" && (
                  <Text size="xsmall" className="mt-1 font-mono text-ui-fg-muted">
                    → {preview}
                  </Text>
                )}
              </div>
            )
          })}
          <Text size="xsmall" className="mt-2 text-ui-fg-muted">
            {t("providers.form.secretHint")}
          </Text>
        </>
      )}
    </div>
  )

  const save = useMutationToast({
    mutationFn: async (): Promise<AuthProviderAdmin> => {
      const fields = fieldsFor(draft.kind)
      const normalized = normalizeConfig(fields, draft.config)
      const managed = isManagedKind(draft.kind)
      const payload = {
        kind: draft.kind,
        name: draft.name.trim(),
        enabled: draft.enabled,
        ...(managed ? { config: normalized } : {}),
      } as AuthProviderUpsert
      return editing
        ? api.updateAdminProvider(editing.id, payload)
        : // À la création : les clés gérées (redirect/callback/discovery/spIssuer)
          // sont résolues par le backend — on ne les envoie pas.
          api.createAdminProvider({
            ...payload,
            id: draft.id.trim(),
            config: omitManagedKeys(normalized, draft.kind),
          } as AuthProviderUpsert & { id: string })
    },
    success: () =>
      t(editing ? "providers.toast.updateSuccess" : "providers.toast.createSuccess"),
    // Rend visible le champ refusé par zod (sinon le message générique
    // "Configuration du fournisseur invalide." ne dit pas ce qui cloche).
    errorDescription: (err) => {
      const details = (err as ApiError).details as Record<string, string[]> | undefined
      const entry = details && Object.entries(details)[0]
      if (!entry) return err.message
      return `${err.message} — ${entry[0]}: ${entry[1]?.[0] ?? ""}`
    },
    invalidate: [["admin", "providers"]],
    onError: (err) => {
      //  le provider nécessite un domaine public configuré avant activation.
      // Aucun retry automatique, l'état du provider n'est jamais modifié.
      if ((err as ApiError).code === "domain_not_configured") {
        toast.error(t("providers.errors.domainNotConfigured"))
      }
    },
    onSuccess: closeModal,
  })

  const activeCount = providers.data?.filter((p) => p.enabled).length ?? 0
  const enabledMut = useMutationToast({
    mutationFn: (p: AuthProviderAdmin) =>
      api.updateAdminProvider(p.id, { enabled: !p.enabled }),
    success: (r) =>
      t("providers.toast.enabledChanged", {
        enabled: r.enabled ? t("providers.badge.enabled") : t("providers.badge.disabled"),
      }),
    invalidate: [["admin", "providers"]],
    onError: (err) => {
      const code = (err as ApiError).code
      // Codes réels API (les anciens « last_active_provider » / local id/prune
      // renvoyaient des 500) : le seul provider actif ne peut être ni désactivé
      // ni supprimé, et une config invalide est un 400 documenté.
      if (code === "cannot_disable_last_provider") {
        toast.error(t("providers.toast.lastActiveProvider"))
      } else if (code === "cannot_delete_last_provider") {
        toast.error(t("providers.toast.lastActiveProviderDelete"))
      } else if (code === "invalid_config") {
        const details = (err as ApiError).details as Record<string, string[]> | undefined
        const entry = details && Object.entries(details)[0]
        toast.error(entry ? `${err.message} — ${entry[0]}: ${entry[1]?.[0] ?? ""}` : err.message)
      } else if (code === "domain_not_configured") {
        toast.error(t("providers.errors.domainNotConfigured"))
      }
    },
  })

  const removeProvider = useConfirmDelete<AuthProviderAdmin>({
    mutationFn: (p) => api.deleteAdminProvider(p.id),
    success: t("providers.toast.deleteSuccess"),
    invalidate: [["admin", "providers"]],
    confirm: (p) => ({
      title: t("providers.deleteConfirm.title"),
      description: t("providers.deleteConfirm.description", { name: p.name }),
    }),
    onError: (err) => {
      if ((err as ApiError).code === "cannot_delete_last_provider") {
        toast.error(t("providers.toast.lastActiveProviderDelete"))
      }
    },
  })

  const [testingId, setTestingId] = useState<string | null>(null)
  const testMut = useMutation({
    mutationFn: async (id: string) => {
      setTestingId(id)
      try {
        return await api.testAdminProvider(id)
      } finally {
        setTestingId(null)
      }
    },
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(t("providers.toast.testOk"))
      } else {
        toast.error(t("providers.toast.testKo", { message: r.message ?? "HTTP" }))
      }
    },
    onError: (err) => {
      toast.error(t("providers.toast.testKo", { message: err.message }))
    },
  })

  // ── Pendings : approbation / rejet ─────────────────────────────────────
  const [approving, setApproving] = useState<PendingIdentity | null>(null)
  const [rejecting, setRejecting] = useState<PendingIdentity | null>(null)
  const [approveTenant, setApproveTenant] = useState("")
  const [approveRole, setApproveRole] = useState<"owner" | "operator" | "viewer">("viewer")
  const [rejectReason, setRejectReason] = useState("")

  const openApprove = (p: PendingIdentity) => {
    setApproveTenant(tenants.data?.[0]?.id ?? "")
    setApproveRole("viewer")
    setApproving(p)
  }

  const approveMut = useMutationToast({
    mutationFn: () =>
      api.approveAdminPending(approving!.id, { tenantId: approveTenant, role: approveRole }),
    success: t("providers.toast.approveSuccess"),
    invalidate: [["admin", "pendings"], ["users"]],
    onSuccess: () => setApproving(null),
  })

  const rejectMut = useMutationToast({
    mutationFn: () =>
      api.rejectAdminPending(rejecting!.id, rejectReason.trim() || undefined),
    success: t("providers.toast.rejectSuccess"),
    invalidate: [["admin", "pendings"]],
    onSuccess: () => setRejecting(null),
  })

  if (!me || !can("owner")) {
    return <Navigate to="/" replace />
  }

  return (
    <PageContainer size="5xl">
      <PageHeader
        title={t("providers.pageTitle")}
        subtitle={t("providers.pageSubtitle")}
        actions={
          <Button size="small" onClick={openCreate}>
            <Plus /> {t("providers.actions.new")}
          </Button>
        }
      />

      {/* ── Onglets : providers / approbations en attente ──────────────────── */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "providers" | "pendings")}>
        <Tabs.List>
          <Tabs.Trigger value="providers">{t("providers.tab.providers")}</Tabs.Trigger>
          <Tabs.Trigger value="pendings">
            {t("providers.tab.pendings")}
            {pendings.data && pendings.data.length > 0 && (
              <span className="ml-1 rounded-full bg-ui-bg-base-pressed px-1.5 text-xs">
                {pendings.data.length}
              </span>
            )}
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="providers" className="mt-5">
          {/* ── Providers tab ──────────────────────────────────────────────── */}
          <div className="mb-4">
            <Heading level="h3">{t("providers.list.title")}</Heading>
            {providers.data && (
              <Text size="small" className="text-ui-fg-muted">
                {t("providers.list.subtitle", { count: providers.data.length })}
              </Text>
            )}
          </div>

          {providers.isLoading ? (
            <div className="rounded-lg border border-ui-border-base bg-ui-bg-base p-6">
              <Text className="text-ui-fg-muted">{t("users.loading")}</Text>
            </div>
          ) : providers.data?.length === 0 ? (
            <div className="rounded-lg border border-ui-border-base bg-ui-bg-base p-8 text-center">
              <ShieldCheck className="mx-auto mb-2 h-8 w-8 text-ui-fg-muted" />
              <Text weight="plus" className="text-ui-fg-base">{t("providers.empty.title")}</Text>
              <Text size="small" className="mt-1 text-ui-fg-muted">{t("providers.empty.description")}</Text>
              <Button size="small" variant="secondary" className="mt-4" onClick={openCreate}>
                <Plus /> {t("providers.actions.new")}
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {providers.data?.map((provider) => {
                const kindInfo = KIND_BADGE[provider.kind] ?? { color: "grey" as const, icon: provider.kind }
                const isLastActive = provider.enabled && activeCount <= 1
                return (
                  <li
                    key={provider.id}
                    className="group rounded-lg border border-ui-border-base bg-ui-bg-base p-4 transition-all hover:shadow-sm sm:p-5"
                  >
                    {/* Header row — clic = détail latéral (pattern liaison database) */}
                    <div className="flex items-start justify-between gap-4">
                      <button
                        type="button"
                        onClick={() => openDetail(provider)}
                        className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-colors duration-150 hover:bg-ui-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-border-interactive"
                      >
                        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ui-bg-subtle">
                          <ShieldCheck className="h-[18px] w-[18px] text-ui-fg-muted" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Text weight="plus" className="truncate text-ui-fg-base">
                              {provider.name}
                            </Text>
                            <Badge size="2xsmall" color={kindInfo.color}>
                              {kindInfo.icon}
                            </Badge>
                            <Badge size="2xsmall" color={provider.enabled ? "green" : "grey"}>
                              {provider.enabled
                                ? t("providers.badge.enabled")
                                : t("providers.badge.disabled")}
                            </Badge>
                          </div>
                          <Text size="xsmall" className="mt-0.5 text-ui-fg-muted">
                            {provider.id}
                          </Text>
                        </div>
                        <ChevronRightMini className="invisible mt-2 h-4 w-4 shrink-0 self-start text-ui-fg-muted transition-colors group-hover:visible" />
                      </button>
                    </div>

                    {/* Actions bar */}
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-ui-border-base pt-3">
                      <div className="flex items-center gap-2">
                        <ToggleSwitch
                          checked={provider.enabled}
                          disabled={isLastActive}
                          onCheckedChange={() => enabledMut.mutate(provider)}
                          aria-label={t("providers.form.enabledLabel")}
                        />
                        <Label size="xsmall" className="text-ui-fg-muted">
                          {t("providers.form.enabledLabel")}
                        </Label>
                      </div>

                      <div className="flex-1" />

                      <div className="flex items-center gap-2">
                        {isManagedKind(provider.kind) && (
                          <Button
                            variant="secondary"
                            size="small"
                            disabled={testingId === provider.id}
                            isLoading={testingId === provider.id}
                            onClick={() => testMut.mutate(provider.id)}
                          >
                            <Beaker />
                            {t("providers.actions.test")}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => openEdit(provider)}
                        >
                          <PencilSquare />
                          {t("providers.actions.edit")}
                        </Button>
                        {provider.id !== "local" && (
                          <Button
                            variant="danger"
                            size="small"
                            onClick={() => removeProvider(provider)}
                          >
                            <Trash />
                            {t("providers.actions.delete")}
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Tabs.Content>

        <Tabs.Content value="pendings" className="mt-5">
          {/* ── Pendings tab ───────────────────────────────────────────────── */}
          <div className="mb-4">
            <Heading level="h3">{t("providers.pendings.title")}</Heading>
            {pendings.data && (
              <Text size="small" className="text-ui-fg-muted">
                {t("providers.pendings.subtitle", { count: pendings.data.length })}
              </Text>
            )}
          </div>

          {pendings.isLoading ? (
            <div className="rounded-lg border border-ui-border-base bg-ui-bg-base p-6">
              <Text className="text-ui-fg-muted">{t("users.loading")}</Text>
            </div>
          ) : pendings.data?.length === 0 ? (
            <div className="rounded-lg border border-ui-border-base bg-ui-bg-base p-8 text-center">
              <CheckCircle className="mx-auto mb-2 h-8 w-8 text-ui-fg-muted" />
              <Text weight="plus" className="text-ui-fg-base">{t("providers.pendings.empty.title")}</Text>
              <Text size="small" className="mt-1 text-ui-fg-muted">{t("providers.pendings.empty.description")}</Text>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {pendings.data?.map((pending) => (
                <li
                  key={pending.id}
                  className="rounded-lg border border-ui-border-base bg-ui-bg-base p-4 transition-all hover:shadow-sm sm:p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ui-bg-subtle">
                        <ShieldCheck className="h-[18px] w-[18px] text-ui-fg-muted" />
                      </div>
                      <div className="min-w-0">
                        <Text weight="plus" className="truncate text-ui-fg-base">
                          {pending.email ?? pending.name ?? t("providers.pendings.emailUnknown")}
                        </Text>
                        <div className="mt-0.5 flex items-center gap-2">
                          <Text size="xsmall" className="text-ui-fg-muted">
                            {pending.providerId}
                          </Text>
                          <Text size="xsmall" className="text-ui-fg-muted">
                            {new Date(pending.createdAt).toLocaleString()}
                          </Text>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={() => openApprove(pending)}
                        disabled={tenants.isLoading || tenants.data?.length === 0}
                      >
                        <CheckCircle /> {t("providers.pendings.approve")}
                      </Button>
                      <Button
                        size="small"
                        variant="danger"
                        onClick={() => {
                          setRejectReason("")
                          setRejecting(pending)
                        }}
                      >
                        <XCircle /> {t("providers.pendings.reject")}
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Tabs.Content>
      </Tabs>

      {/* ── Modal create/edit provider ─────────────────────────────────── */}
      <FocusModal open={modalOpen} onOpenChange={(o) => o || closeModal()}>
        <FocusModal.Content>
          <FocusModal.Header>
            <FocusModal.Title asChild>
              <Heading>
                {editing
                  ? t("providers.form.titleEdit", { name: editing.name })
                  : t("providers.form.titleCreate")}
              </Heading>
            </FocusModal.Title>
          </FocusModal.Header>
          <FocusModal.Body className="overflow-y-auto">
            {!editing && (
              <Stepper
                className="mx-auto mb-5 mt-3 w-full max-w-sm"
                steps={[
                  t("providers.wizard.stepIdentity"),
                  t("providers.wizard.stepConfig"),
                  t("providers.wizard.stepVerify"),
                ]}
                current={createStep}
              />
            )}
            <ModalForm size="lg" onSubmit={onSubmitModal}>
              {!editing && createStep === 0 ? (
                /* ── Étape 1 : identité ────────────────────────────────── */
                <div key="step-0" className="hb-animate-fade-up grid gap-5">
                  {renderIdentityFields(false)}
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" type="button" onClick={closeModal}>
                      {t("providers.actions.cancel")}
                    </Button>
                    <Button type="button" disabled={!basicValid()} onClick={goToNextStep}>
                      {t("providers.wizard.continue")}
                    </Button>
                  </div>
                </div>
              ) : !editing && createStep === 1 ? (
                /* ── Étape 2 : configuration ───────────────────────────── */
                <div key="step-1" className="hb-animate-fade-up grid gap-5">
                  {renderConfigFields()}
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" type="button" onClick={() => setCreateStep(0)}>
                      {t("providers.wizard.back")}
                    </Button>
                    <Button type="button" disabled={!configValid()} onClick={goToNextStep}>
                      {t("providers.wizard.continue")}
                    </Button>
                  </div>
                </div>
              ) : !editing ? (
                /* ── Étape 3 : vérification + activation ──────────────── */
                <div className="hb-animate-fade-up grid gap-5">
                  <div>
                    <Text weight="plus" size="small">
                      {t("providers.wizard.verifyTitle")}
                    </Text>
                    <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                      {t("providers.wizard.verifyDescription")}
                    </Text>
                  </div>

                  {preflightMut.isPending ? (
                    <div className="rounded-lg border border-ui-border-base bg-ui-bg-base p-4">
                      <Text size="small" className="text-ui-fg-muted">
                        {t("providers.wizard.verifyRunning")}
                      </Text>
                    </div>
                  ) : !preflight ? null : (
                    <div className="overflow-hidden rounded-lg border border-ui-border-base bg-ui-bg-base">
                      <div className="flex items-center gap-2 border-b border-ui-border-base px-4 py-3">
                        {preflight.ok ? (
                          <CheckCircle className="h-4 w-4 text-ui-fg-success" />
                        ) : (
                          <XCircle className="h-4 w-4 text-ui-fg-error" />
                        )}
                        <Text size="small" weight="plus">
                          {preflight.ok
                            ? t("providers.wizard.verifyOk")
                            : t("providers.wizard.verifyKo")}
                        </Text>
                      </div>
                      {preflight.details && (
                        <Text
                          size="xsmall"
                          className="px-4 py-2 font-mono text-ui-fg-error"
                        >
                          {(() => {
                            const det = preflight.details as Record<string, string[]> | undefined
                            const first = det && Object.entries(det)[0]
                            return first ? `${first[0]}: ${first[1]?.[0] ?? ""}` : "—"
                          })()}
                        </Text>
                      )}
                      {preflight.steps.length > 0 && (
                        <ul className="divide-y divide-ui-border-base">
                          {preflight.steps.map((step) => (
                            <li key={step.step} className="flex items-center gap-2 px-4 py-2.5">
                              {step.ok ? (
                                <CheckCircle className="h-3.5 w-3.5 shrink-0 text-ui-fg-success" />
                              ) : (
                                <XCircle className="h-3.5 w-3.5 shrink-0 text-ui-fg-error" />
                              )}
                              <Text size="small" className="text-ui-fg-base">
                                {t(`providers.preflight.${step.step}`)}
                              </Text>
                              {!step.ok && step.latencyMs !== undefined && (
                                <Text size="xsmall" className="ml-auto text-ui-fg-muted">
                                  {step.latencyMs}ms
                                </Text>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {preflight && !preflight.ok && (
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {t("providers.wizard.verifyBlockedHint")}
                    </Text>
                  )}

                  <div className="flex items-center gap-2">
                    <ToggleSwitch
                      checked={draft.enabled}
                      onCheckedChange={(checked) => setDraft((d) => ({ ...d, enabled: checked }))}
                      aria-label={t("providers.form.enabledLabel")}
                    />
                    <div>
                      <Text weight="plus" size="small">
                        {t("providers.form.enabledLabel")}
                      </Text>
                      <Text size="xsmall" className="text-ui-fg-muted">
                        {t("providers.form.enabledHint")}
                      </Text>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <ToggleSwitch
                      checked={draft.enabled}
                      onCheckedChange={(checked) => setDraft((d) => ({ ...d, enabled: checked }))}
                      aria-label={t("providers.form.enabledLabel")}
                    />
                    <div>
                      <Text weight="plus" size="small">
                        {t("providers.form.enabledLabel")}
                      </Text>
                      <Text size="xsmall" className="text-ui-fg-muted">
                        {t("providers.form.enabledHint")}
                      </Text>
                    </div>
                  </div>

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={preflightMut.isPending}
                      onClick={() => setCreateStep(1)}
                    >
                      {t("providers.wizard.back")}
                    </Button>
                    <Button
                      type="submit"
                      isLoading={save.isPending}
                      disabled={
                        draft.enabled && (!preflight || !preflight.ok || preflightMut.isPending)
                      }
                    >
                      {t("providers.actions.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                /* ── Édition : formulaire entier, sans wizard ──────────── */
                <div className="grid gap-5">
                  {renderIdentityFields(true)}
                  {renderConfigFields()}
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" type="button" onClick={closeModal}>
                      {t("providers.actions.cancel")}
                    </Button>
                    <Button type="submit" isLoading={save.isPending} disabled={!canSave()}>
                      {t("providers.actions.save")}
                    </Button>
                  </div>
                </div>
              )}
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>

      {/* ── Détail latéral d'un provider ───────────────────────────────── */}
      <ProviderDetailDrawer
        open={detailOpen}
        provider={detail}
        isLastActive={detail?.enabled ? activeCount <= 1 : false}
        testing={testingId === detail?.id}
        actions={{
          onClose: () => setDetailOpen(false),
          onToggle: () => detail && enabledMut.mutate(detail),
          onTest: () => detail && testMut.mutate(detail.id),
          onEdit: () => {
            if (detail) openEdit(detail)
            setDetailOpen(false)
          },
          onDelete: () => detail && removeProvider(detail),
        }}
        t={t}
      />

      {/* ── Modal approbation ──────────────────────────────────────────── */}
      <FocusModal open={!!approving} onOpenChange={(o) => o || setApproving(null)}>
        <FocusModal.Content>
          <FocusModal.Header>
            <FocusModal.Title asChild>
              <Heading>
                {t("providers.pendings.approveTitle", {
                  email: approving?.email ?? t("providers.pendings.emailUnknown"),
                })}
              </Heading>
            </FocusModal.Title>
          </FocusModal.Header>
          <FocusModal.Body>
            <ModalForm
              onSubmit={() =>
                approveTenant && approveRole && !approveMut.isPending && approveMut.mutate()
              }
            >
              <div>
                <Label size="small">{t("providers.pendings.approveDesc")}</Label>
              </div>
              {tenants.isLoading ? (
                <Text className="text-ui-fg-subtle">{t("users.loading")}</Text>
              ) : tenants.data && tenants.data.length > 0 ? (
                <>
                  <div>
                    <Label size="small">{t("providers.pendings.tenantLabel")}</Label>
                    <Select value={approveTenant} onValueChange={setApproveTenant}>
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {tenants.data.map((tenant) => (
                          <Select.Item key={tenant.id} value={tenant.id}>
                            {tenant.name} ({tenant.slug})
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select>
                  </div>
                  <div>
                    <Label size="small">{t("providers.pendings.roleLabel")}</Label>
                    <Select
                      value={approveRole}
                      onValueChange={(v) =>
                        setApproveRole(v as "owner" | "operator" | "viewer")
                      }
                    >
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        <Select.Item value="viewer">{t("users.createModal.roleViewer")}</Select.Item>
                        <Select.Item value="operator">{t("users.createModal.roleOperator")}</Select.Item>
                        <Select.Item value="owner">{t("nav.ownerBadge")}</Select.Item>
                      </Select.Content>
                    </Select>
                    <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                      {t("providers.pendings.roleHint")}
                    </Text>
                  </div>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="secondary" type="button" onClick={() => setApproving(null)}>
                      {t("providers.actions.cancel")}
                    </Button>
                    <Button type="submit" isLoading={approveMut.isPending}>
                      {t("providers.toast.approveSuccess")}
                    </Button>
                  </div>
                </>
              ) : (
                <div>
                  <Text className="text-ui-fg-subtle">
                    {t("providers.pendings.empty.title")}
                  </Text>
                </div>
              )}
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>

      {/* ── Modal rejet ────────────────────────────────────────────────── */}
      <FocusModal open={!!rejecting} onOpenChange={(o) => o || setRejecting(null)}>
        <FocusModal.Content>
          <FocusModal.Header>
            <FocusModal.Title asChild>
              <Heading>
                {t("providers.pendings.rejectTitle", {
                  email: rejecting?.email ?? t("providers.pendings.emailUnknown"),
                })}
              </Heading>
            </FocusModal.Title>
          </FocusModal.Header>
          <FocusModal.Body>
            <ModalForm onSubmit={() => !rejectMut.isPending && rejectMut.mutate()}>
              <Text>{t("providers.pendings.rejectDesc", {
                email: rejecting?.email ?? t("providers.pendings.emailUnknown"),
              })}</Text>
              <div>
                <Label size="small">{t("providers.pendings.reasonLabel")}</Label>
                <Textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  rows={2}
                />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="secondary" type="button" onClick={() => setRejecting(null)}>
                  {t("providers.actions.cancel")}
                </Button>
                <Button variant="danger" type="submit" isLoading={rejectMut.isPending}>
                  {t("providers.toast.rejectSuccess")}
                </Button>
              </div>
            </ModalForm>
          </FocusModal.Body>
        </FocusModal.Content>
      </FocusModal>
    </PageContainer>
  )
}
