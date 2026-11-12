import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Container, Heading, Input, Label, Tabs, Text } from "@medusajs/ui"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { useTranslation } from "react-i18next"
import { LanguageSwitch } from "../components/LanguageSwitch"
import { PasskeysCard } from "../components/PasskeysCard"
import { ToggleSwitch } from "../components/ToggleSwitch"
import { MailSettingsSection } from "../components/MailSettingsSection"
import { useNavigate } from "react-router-dom";

/**
 * Page Paramètres : profil + langue (tous), MFA et clés de sécurité (tous),
 * plus la configuration Domaine & WebAuthn / Passkeys réservée au owner.
 * WebAuthn : la config RP (origin/rpId/rpName) est stockée en base par tenant —
 * plus aucune variable d'environnement WEBAUTHN_*.
 */
export function SettingsPage() {
  const { t } = useTranslation()
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })
  const isOwner = me?.role === "owner"

  const [activeTab, setActiveTab] = useState<"profile" | "security" | "domain" | "mail">("profile")

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const changePw = useMutationToast({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    success: t('settings.toast.passwordChanged'),
    onSuccess: () => {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    },
  })

  const navigate = useNavigate();

  const pwMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const pwTooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmitPw =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword

  // ── WebAuthn / Passkeys (config tenant, owner) ──
  const { data: domainData } = useQuery({
    queryKey: ["domain"],
    queryFn: api.getDomain,
    enabled: isOwner,
  })
  const { data: wc } = useQuery({
    queryKey: ["settings", "webauthn"],
    queryFn: api.getSettingsWebauthn,
    enabled: isOwner,
  })

  const [wEnabled, setWEnabled] = useState(false)
  const [wOrigin, setWOrigin] = useState("")
  const [wRpId, setWRpId] = useState("")
  const [wRpName, setWRpName] = useState("")

  useEffect(() => {
    if (!wc) return
    setWEnabled(wc.enabled)
    setWOrigin(wc.origin ?? "")
    setWRpId(wc.rpId ?? "")
    setWRpName(wc.rpName ?? "")
  }, [wc])

  const saveWebauthn = useMutationToast({
    mutationFn: () =>
      api.setSettingsWebauthn({
        enabled: wEnabled,
        ...(wOrigin.trim() ? { origin: wOrigin.trim() } : {}),
        ...(wRpId.trim() ? { rpId: wRpId.trim() } : {}),
        ...(wRpName.trim() ? { rpName: wRpName.trim() } : {}),
      }),
    success: t("settings.webauthn.saved"),
    invalidate: [["settings", "webauthn"]],
  })

  const webauthnConfigured = Boolean(wc?.enabled && wc?.origin)

  return (
    <PageContainer size="2xl">
      <PageHeader title={t('settings.pageTitle')} />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "profile" | "security" | "domain" | "mail")}
      >
        <Tabs.List>
          <Tabs.Trigger value="profile" data-testid="settings-tab-profile">
            {t('settings.tabs.profile')}
          </Tabs.Trigger>
          <Tabs.Trigger value="security" data-testid="settings-tab-security">
            {t('settings.tabs.security')}
          </Tabs.Trigger>
          {isOwner && (
            <Tabs.Trigger value="domain" data-testid="settings-tab-domain">
              {t('settings.tabs.domain')}
            </Tabs.Trigger>
          )}
          {isOwner && (
            <Tabs.Trigger value="mail" data-testid="settings-tab-mail">
              {t('settings.tabs.mail', 'E-mails & Alertes')}
            </Tabs.Trigger>
          )}
        </Tabs.List>

        {/* Profil : compte + langue */}
        <Tabs.Content value="profile" className="mt-5">
          <Container className="mb-4 p-6">
            <Heading level="h3" className="mb-3">
              {t('settings.account.title')}
            </Heading>
            <div className="flex flex-col gap-2">
              <div>
                <Label size="small">{t('settings.account.emailLabel')}</Label>
                <Text>{me?.email ?? "…"}</Text>
              </div>
              <div>
                <Label size="small">{t('settings.account.roleLabel')}</Label>
                <Text className="capitalize">{me?.role ?? "…"}</Text>
              </div>
            </div>
          </Container>

          <Container className="mb-4 p-6">
            <Heading level="h3" className="mb-3">
              {t('settings.language.title')}
            </Heading>
            <div className="flex flex-col gap-2">
              <Label size="small">{t('settings.language.selectLabel')}</Label>
              <div className="w-48">
                <LanguageSwitch />
              </div>
              <Text size="xsmall" className="text-ui-fg-muted">
                {t('settings.language.hint')}
              </Text>
            </div>
          </Container>
        </Tabs.Content>

        {/* Sécurité : mot de passe + clés de sécurité */}
        <Tabs.Content value="security" className="mt-5">
          <Container className="mb-4 p-6">
            <Heading level="h3" className="mb-3">
              {t('settings.password.title')}
            </Heading>
            <div className="flex flex-col gap-3">
              <div>
                <Label size="small">{t('settings.password.currentLabel')}</Label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div>
                <Label size="small">{t('settings.password.newLabel')}</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder={t('settings.password.newPlaceholder')}
                />
                {pwTooShort && (
                  <Text size="xsmall" className="mt-1 text-ui-fg-error">
                    {t('settings.password.tooShortError')}
                  </Text>
                )}
              </div>
              <div>
                <Label size="small">{t('settings.password.confirmLabel')}</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
                {pwMismatch && (
                  <Text size="xsmall" className="mt-1 text-ui-fg-error">
                    {t('settings.password.mismatchError')}
                  </Text>
                )}
              </div>
              <Button
                onClick={() => changePw.mutate()}
                isLoading={changePw.isPending}
                disabled={!canSubmitPw}
                className="self-start"
              >
                {t('settings.password.submitButton')}
              </Button>
            </div>
          </Container>

          <PasskeysCard />
        </Tabs.Content>

        {/* Domaine + WebAuthn (owner uniquement) */}
        {isOwner && (
          <Tabs.Content value="domain" className="mt-5">
            <Container className="mb-4 p-6">
              <Heading level="h3" className="mb-3">
                {t('settings.domain.title')}
              </Heading>
              <Text size="small" className="text-ui-fg-subtle mb-3">
                {t('settings.domain.hint')}
              </Text>
              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={() => navigate("/setup-domain")}>
                  {t('settings.domain.configureButton')}
                </Button>
                {domainData?.domain && (
                  <Badge color="green">{domainData.domain}</Badge>
                )}
              </div>
              {!domainData?.domain && (
                <Text size="xsmall" className="mt-2 text-ui-fg-muted">
                  {t("settings.webauthn.noDomainHint")}
                </Text>
              )}
            </Container>

            <Container className="mb-4 p-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Heading level="h3" className="mb-0">
                  {t('settings.webauthn.title')}
                </Heading>
                <Badge color={webauthnConfigured ? "green" : "grey"}>
                  {webauthnConfigured
                    ? t("settings.webauthn.configured")
                    : t("settings.webauthn.notConfigured")}
                </Badge>
              </div>
              <Text size="small" className="text-ui-fg-subtle mb-4">
                {t('settings.webauthn.hint')}
              </Text>

              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <ToggleSwitch
                    checked={wEnabled}
                    onCheckedChange={(checked) => setWEnabled(checked)}
                    aria-label={t("settings.webauthn.enabledLabel")}
                  />
                  <div>
                    <Text weight="plus" size="small">
                      {t("settings.webauthn.enabledLabel")}
                    </Text>
                    <Text size="xsmall" className="text-ui-fg-muted">
                      {t("settings.webauthn.enabledHint")}
                    </Text>
                  </div>
                </div>

                <div>
                  <Label size="small">{t("settings.webauthn.originLabel")}</Label>
                  <Input
                    value={wOrigin}
                    onChange={(e) => setWOrigin(e.target.value)}
                    placeholder={wOrigin || `https://${domainData?.domain ?? ""}`}
                  />
                  {!domainData?.domain && (
                    <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                      {t("settings.webauthn.noDomainHint")}
                    </Text>
                  )}
                </div>

                <div>
                  <Label size="small">{t("settings.webauthn.rpIdLabel")}</Label>
                  <Input
                    value={wRpId}
                    onChange={(e) => setWRpId(e.target.value)}
                    placeholder={t("settings.webauthn.rpIdPlaceholder")}
                  />
                  <Text size="xsmall" className="mt-1 text-ui-fg-muted">
                    {t("settings.webauthn.rpIdHint")}
                  </Text>
                </div>

                <div>
                  <Label size="small">{t("settings.webauthn.rpNameLabel")}</Label>
                  <Input
                    value={wRpName}
                    onChange={(e) => setWRpName(e.target.value)}
                    placeholder="Hullbay"
                  />
                </div>

                <Button
                  onClick={() => saveWebauthn.mutate()}
                  isLoading={saveWebauthn.isPending}
                  className="self-start"
                >
                  {t("settings.webauthn.saveButton")}
                </Button>
              </div>
            </Container>
          </Tabs.Content>
        )}

        {isOwner && (
          <Tabs.Content value="mail" className="mt-5">
            <MailSettingsSection />
          </Tabs.Content>
        )}
      </Tabs>
    </PageContainer>
  );
}