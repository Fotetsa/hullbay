import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Container, Heading, Input, Label, Select, Text, toast } from "@medusajs/ui"
import { useTranslation } from "react-i18next"
import { api, type MailSettings } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { ToggleSwitch } from "./ToggleSwitch"

/**
 * Section de configuration de la messagerie transactionnelle (Resend / SMTP).
 *
 * Réservée aux propriétaires de tenant (Owner). Permet de :
 * - Sélectionner le fournisseur (Resend via API REST ou Relais SMTP standard).
 * - Activer ou désactiver l'envoi des e-mails.
 * - Saisir et chiffrer les identifiants d'accès.
 * - Déclencher un envoi de test avec rapport d'état immédiat.
 */
export function MailSettingsSection() {
  const { t } = useTranslation()

  // ── Données de configuration actuelles ──
  const { data: config } = useQuery({
    queryKey: ["settings", "mail"],
    queryFn: api.getMailSettings,
  })

  // États du formulaire
  const [provider, setProvider] = useState<"RESEND" | "SMTP">("RESEND")
  const [enabled, setEnabled] = useState(false)
  const [fromEmail, setFromEmail] = useState("")
  const [fromName, setFromName] = useState("Hullbay Ops")
  const [replyTo, setReplyTo] = useState("")

  // États Resend
  const [resendApiKey, setResendApiKey] = useState("")

  // États SMTP
  const [smtpHost, setSmtpHost] = useState("")
  const [smtpPort, setSmtpPort] = useState(587)
  const [smtpSecure, setSmtpSecure] = useState(false)
  const [smtpUser, setSmtpUser] = useState("")
  const [smtpPass, setSmtpPass] = useState("")

  // Synchronisation avec les données distantes
  useEffect(() => {
    if (!config) return
    setProvider(config.provider || "RESEND")
    setEnabled(config.enabled ?? false)
    setFromEmail(config.fromEmail ?? "")
    setFromName(config.fromName ?? "Hullbay Ops")
    setReplyTo(config.replyTo ?? "")

    if (config.resend?.apiKey) {
      setResendApiKey(config.resend.apiKey)
    }
    if (config.smtp) {
      setSmtpHost(config.smtp.host ?? "")
      setSmtpPort(config.smtp.port ?? 587)
      setSmtpSecure(config.smtp.secure ?? false)
      setSmtpUser(config.smtp.user ?? "")
      setSmtpPass(config.smtp.pass ?? "")
    }
  }, [config])

  // ── Sauvegarde de la configuration ──
  const saveMutation = useMutationToast({
    mutationFn: () =>
      api.saveMailSettings({
        provider,
        enabled,
        fromEmail: fromEmail.trim(),
        fromName: fromName.trim() || undefined,
        replyTo: replyTo.trim() || undefined,
        resend:
          provider === "RESEND"
            ? {
                apiKey: resendApiKey.trim() || undefined,
              }
            : undefined,
        smtp:
          provider === "SMTP"
            ? {
                host: smtpHost.trim(),
                port: Number(smtpPort) || 587,
                secure: smtpSecure,
                user: smtpUser.trim() || undefined,
                pass: smtpPass.trim() || undefined,
              }
            : undefined,
      }),
    success: t("settings.mail.toastSaved", "Configuration des e-mails enregistrée"),
    invalidate: [["settings", "mail"]],
  })

  // ── Envoi d'e-mail de test synchrone avec rapport d'état ──
  const [testing, setTesting] = useState(false)
  const handleTestMail = async () => {
    setTesting(true)
    try {
      const res = await api.sendTestMail()
      toast.success(
        t("settings.mail.toastTestSent", "E-mail de test envoyé avec succès !"),
        { description: res.message }
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t("settings.mail.toastTestFailed", "Échec de l'envoi de l'e-mail de test"), {
        description: msg,
      })
    } finally {
      setTesting(false)
    }
  }

  const providers = [
    { value: "RESEND", label: "Resend (API REST)" },
    { value: "SMTP", label: "Relais SMTP standard" },
  ]

  return (
    <Container className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <Heading level="h3">{t("settings.mail.title", "Notifications & E-mails")}</Heading>
          <Text size="small" className="text-ui-fg-muted">
            {t(
              "settings.mail.hint",
              "Configurez l'expédition des alertes (déploiements Swarm, sécurité, dérives) via Resend ou SMTP."
            )}
          </Text>
        </div>
        <Badge color={enabled ? "green" : "grey"} size="small">
          {enabled
            ? t("settings.mail.statusActive", "Actif")
            : t("settings.mail.statusInactive", "Désactivé")}
        </Badge>
      </div>

      {/* Switch d'activation */}
      <div className="flex items-center gap-3 p-3 mb-6 bg-ui-bg-subtle rounded-md border border-ui-border-base">
        <ToggleSwitch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t("settings.mail.enabledLabel", "Activer les notifications e-mail")}
        />
        <div>
          <Text weight="plus" size="small">
            {t("settings.mail.enabledLabel", "Activer l'envoi d'e-mails")}
          </Text>
          <Text size="xsmall" className="text-ui-fg-muted">
            {t(
              "settings.mail.enabledHint",
              "Transmet les rapports d'incidents, succès de déploiement et alertes de sécurité aux opérateurs."
            )}
          </Text>
        </div>
      </div>

      {/* Sélection du Fournisseur via Select Medusa UI pleine largeur */}
      <div className="mb-6 max-w-xl">
        <Label size="small" className="mb-1 block">
          {t("settings.mail.providerLabel", "Fournisseur de messagerie")}
        </Label>
        <Select
          value={provider}
          onValueChange={(val) => setProvider(val as "RESEND" | "SMTP")}
        >
          <Select.Trigger className="w-full">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {providers.map((p) => (
              <Select.Item key={p.value} value={p.value}>
                {p.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>

      {/* Formulaire spécifique selon le provider sélectionné */}
      {provider === "RESEND" ? (
        <div className="space-y-4 mb-6 p-4 rounded-md border border-ui-border-base bg-ui-bg-subtle/50 max-w-xl">
          <div>
            <Label size="small" className="mb-1 block">
              {t("settings.mail.resendApiKeyLabel", "Clé API Resend")}
            </Label>
            <Input
              type="password"
              placeholder="re_••••••••••••••••"
              value={resendApiKey}
              onChange={(e) => setResendApiKey(e.target.value)}
              autoComplete="off"
            />
            <Text size="xsmall" className="text-ui-fg-muted mt-1">
              {t(
                "settings.mail.resendApiKeyHint",
                "Clé chiffrée en base (AES-GCM). Ne sera jamais réaffichée en clair."
              )}
            </Text>
          </div>
        </div>
      ) : (
        <div className="space-y-4 mb-6 p-4 rounded-md border border-ui-border-base bg-ui-bg-subtle/50 max-w-xl">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Label size="small" className="mb-1 block">
                {t("settings.mail.smtpHostLabel", "Serveur SMTP (Hôte)")}
              </Label>
              <Input
                placeholder="smtp.example.com"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
              />
            </div>
            <div>
              <Label size="small" className="mb-1 block">
                {t("settings.mail.smtpPortLabel", "Port")}
              </Label>
              <Input
                type="number"
                placeholder="587"
                value={smtpPort}
                onChange={(e) => setSmtpPort(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ToggleSwitch
              checked={smtpSecure}
              onCheckedChange={setSmtpSecure}
              aria-label={t("settings.mail.smtpSecureLabel", "Chiffrement SSL/TLS (port 465)")}
            />
            <Text size="small">
              {t("settings.mail.smtpSecureLabel", "Connexion directe SSL/TLS (port 465)")}
            </Text>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label size="small" className="mb-1 block">
                {t("settings.mail.smtpUserLabel", "Utilisateur SMTP (optionnel)")}
              </Label>
              <Input
                placeholder="user@example.com"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <Label size="small" className="mb-1 block">
                {t("settings.mail.smtpPassLabel", "Mot de passe SMTP")}
              </Label>
              <Input
                type="password"
                placeholder="••••••••"
                value={smtpPass}
                onChange={(e) => setSmtpPass(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
        </div>
      )}

      {/* Paramètres de l'expéditeur (communs) */}
      <div className="space-y-4 mb-6 max-w-xl">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label size="small" className="mb-1 block">
              {t("settings.mail.fromEmailLabel", "E-mail expéditeur (From)")}
            </Label>
            <Input
              type="email"
              placeholder="notifications@votre-domaine.com"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
            />
          </div>
          <div>
            <Label size="small" className="mb-1 block">
              {t("settings.mail.fromNameLabel", "Nom affiché")}
            </Label>
            <Input
              placeholder="Hullbay Ops"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Label size="small" className="mb-1 block">
            {t("settings.mail.replyToLabel", "Adresse Reply-To (optionnelle)")}
          </Label>
          <Input
            type="email"
            placeholder="support@votre-domaine.com"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
          />
        </div>
      </div>

      {/* Actions : Enregistrer et Tester */}
      <div className="flex items-center gap-3 pt-4 border-t border-ui-border-base">
        <Button
          onClick={() => saveMutation.mutate()}
          isLoading={saveMutation.isPending}
          disabled={!fromEmail.trim()}
        >
          {t("settings.mail.saveButton", "Enregistrer la configuration")}
        </Button>

        <Button
          variant="secondary"
          onClick={handleTestMail}
          isLoading={testing}
          disabled={!config?.enabled || saveMutation.isPending}
        >
          {t("settings.mail.testButton", "Envoyer un e-mail de test")}
        </Button>
      </div>
    </Container>
  )
}
