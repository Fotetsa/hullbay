import { useState, useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text, Select } from "@medusajs/ui"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { useTranslation } from "react-i18next"
import { LanguageSwitch } from "../components/LanguageSwitch"
import { useNavigate } from "react-router-dom";

/**
 * Page Paramètres utilisateur : profil + activation de la MFA (TOTP).
 * Enrôlement : on récupère le secret/otpauth, l'utilisateur l'ajoute à son app
 * d'authentification (saisie du secret), puis confirme avec un 1er code.
 */
export function SettingsPage() {
  const { t, i18n } = useTranslation()
  const locale = i18n.language?.startsWith("en") ? "en" : "fr"
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })

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
  const { data: envData } = useQuery({
    queryKey: ["environment"],
    queryFn: api.getEnvironment,
  });
  const isProduction = envData?.environment === "production";

  // Mail settings (owner-only)
  const { data: mailSettings, refetch: refetchMail } = useQuery({
    queryKey: ["mailSettings"],
    queryFn: api.getMailSettings,
  })

  const [provider, setProvider] = useState<string>("resend")
  const [enabled, setEnabled] = useState<boolean>(true)
  const [defaultFrom, setDefaultFrom] = useState<string>("")
  const [resendApiKey, setResendApiKey] = useState("")
  const [smtpHost, setSmtpHost] = useState("")
  const [smtpPort, setSmtpPort] = useState<string>("587")
  const [smtpUser, setSmtpUser] = useState("")
  const [smtpPass, setSmtpPass] = useState("")
  const [testEmail, setTestEmail] = useState("")
  const [isTested, setIsTested] = useState<boolean>(false)
  const [saved, setSaved] = useState<boolean>(false)
  const [editing, setEditing] = useState<boolean>(true)

  useEffect(() => {
    const m = mailSettings?.[0]
    if (m) {
      setProvider(m.provider ?? "resend")
      setEnabled(m.enabled !== false)
      setDefaultFrom(m.defaultFrom ?? "")
      setSaved(true)
      setEditing(false)
    } else {
      setEnabled(true)
      setEditing(true)
    }
  }, [mailSettings])

  const saveMail = useMutationToast({
    mutationFn: () =>
      api.setMailSettings({
        provider,
        config:
          provider === "resend"
            ? { apiKey: resendApiKey, from: defaultFrom || undefined }
            : { host: smtpHost, port: Number(smtpPort || 587), user: smtpUser, password: smtpPass, from: defaultFrom || undefined },
        enabled: true,
        defaultFrom,
      }),
    success: t('settings.mail.saveSuccess') ?? "Saved",
    onSuccess: () => {
      refetchMail?.()
      setSaved(true)
      setEditing(false)
      setIsTested(false)
    },
  })

  const testMail = useMutationToast({
    mutationFn: () =>
      api.testMail({
        to: testEmail,
        from: defaultFrom || undefined,
        provider,
        locale,
        config: provider === "resend" ? { apiKey: resendApiKey, from: defaultFrom || undefined } : { host: smtpHost, port: Number(smtpPort || 587), user: smtpUser, password: smtpPass, from: defaultFrom || undefined },
      }),
    success: t('settings.mail.testSuccess') ?? "Test email sent",
    onSuccess: () => setIsTested(true),
  })

  const pwMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const pwTooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmitPw =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword

  return (
    <PageContainer size="2xl">
      <PageHeader title={t('settings.pageTitle')} />

      {/* Profil */}
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

      {/* Langue */}
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

      {/* Mot de passe */}
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

      {me?.role === 'owner' && (
        <Container className="mb-4 p-6">
          <Heading level="h3" className="mb-3">
            {t('settings.mail.title') ?? 'Mail'}
          </Heading>

          <Text size="small" className="text-ui-fg-muted">
            {t('settings.mail.infoText') ?? "Configure outbound email to enable notifications and test messages."}
          </Text>

          <div className="flex flex-col gap-3 mt-4">
            <div>
                <Label size="small">{t('settings.mail.providerLabel') ?? 'Provider'}</Label>
                <Select value={provider} onValueChange={(v: string) => setProvider(v)}>
                  <Select.Trigger className="w-full">
                    <Select.Value placeholder={t('settings.mail.providerLabel') ?? 'Provider'} />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="resend">Resend</Select.Item>
                    <Select.Item value="smtp">SMTP</Select.Item>
                  </Select.Content>
                </Select>
              <Text size="xsmall" className="text-ui-fg-muted mt-1">{t('settings.mail.providerHelp') ?? 'Choose the email provider: Resend (API) or SMTP server.'}</Text>
            </div>

            <div>
              <Label size="small">{t('settings.mail.defaultFromLabel') ?? 'Default From'}</Label>
              <Input value={defaultFrom} onChange={(e) => setDefaultFrom(e.target.value)} placeholder="no-reply@example.com" disabled={!editing} />
            </div>

            {provider === 'resend' && (
              <div>
                <Label size="small">{t('settings.mail.resendApiKeyLabel') ?? 'Resend API key'}</Label>
                <Input type="password" value={resendApiKey} onChange={(e) => setResendApiKey(e.target.value)} placeholder={t('settings.mail.resendApiKeyPlaceholder') ?? ''} disabled={!editing} />
                <Text size="xsmall" className="text-ui-fg-muted mt-1">{t('settings.mail.resendHelp') ?? 'Paste your Resend API key here. It will be stored encrypted.'}</Text>
              </div>
            )}

            {provider === 'smtp' && (
              <>
                <div>
                  <Label size="small">{t('settings.mail.smtpHostLabel') ?? 'SMTP host'}</Label>
                  <Input placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} disabled={!editing} />
                </div>
                <div>
                  <Label size="small">{t('settings.mail.smtpPortLabel') ?? 'SMTP port'}</Label>
                  <Input placeholder="587" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} disabled={!editing} />
                </div>
                <div>
                  <Label size="small">{t('settings.mail.smtpUserLabel') ?? 'SMTP user'}</Label>
                  <Input placeholder="username" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} disabled={!editing} />
                </div>
                <div>
                  <Label size="small">{t('settings.mail.smtpPassLabel') ?? 'SMTP password'}</Label>
                  <Input type="password" placeholder="(never shown again)" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} disabled={!editing} />
                </div>
                <Text size="xsmall" className="text-ui-fg-muted mt-1">{t('settings.mail.smtpHelp') ?? 'SMTP host/port/user/password for your outgoing SMTP server. Password will be stored encrypted.'}</Text>
              </>
            )}

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label size="small">{t('settings.mail.testEmailLabel') ?? 'Test recipient'}</Label>
                <Input placeholder={t('settings.mail.testEmailPlaceholder') ?? 'you@example.com'} value={testEmail} onChange={(e) => setTestEmail(e.target.value)} disabled={!editing} />
              </div>
              {editing ? (
                <>
                  <Button onClick={() => testMail.mutate()} isLoading={testMail.isPending} disabled={!testEmail} className="self-end">
                    {t('settings.mail.testButton') ?? 'Send test email'}
                  </Button>
                  <div className="ml-3 self-end">
                    {isTested && <Text size="small" className="text-ui-fg-success">{t('settings.mail.testPassed') ?? 'Test succeeded'}</Text>}
                  </div>
                </>
              ) : (
                <Button variant="secondary" onClick={() => setEditing(true)}>{t('settings.mail.editButton') ?? 'Modify'}</Button>
              )}
            </div>

            <div className="flex gap-2 items-center">
              <Button onClick={() => saveMail.mutate()} isLoading={saveMail.isPending} disabled={!isTested || !editing}>
                {t('settings.mail.saveButton') ?? 'Save'}
              </Button>
              {editing && <Button variant="secondary" onClick={() => { setIsTested(false); if (saved) { setProvider(mailSettings?.[0]?.provider ?? 'resend'); setDefaultFrom(mailSettings?.[0]?.defaultFrom ?? ''); setEditing(false); } else { setProvider('resend'); setDefaultFrom(''); setResendApiKey(''); setSmtpHost(''); setSmtpPort('587'); setSmtpUser(''); setSmtpPass(''); } }}>
                {t('settings.mail.cancelButton') ?? 'Cancel'}
              </Button>}
            </div>
          </div>
        </Container>
      )}

      {!isProduction && (
        <Container className="mb-4 p-6">
          <Heading level="h3" className="mb-3">
            {t('settings.domain.title')}
          </Heading>
          <Text size="small" className="text-ui-fg-subtle mb-3">
            {t('settings.domain.hint')}
          </Text>
          <Button variant="secondary" onClick={() => navigate("/setup-domain")}>
            {t('settings.domain.configureButton')}
          </Button>
        </Container>
      )}
    </PageContainer>
  );
}