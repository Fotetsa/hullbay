import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text, Select } from "@medusajs/ui"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { useTranslation } from "react-i18next"

export function MailIntegrationPage() {

  const { t, i18n } = useTranslation()
  const locale = i18n.language?.startsWith("en") ? "en" : "fr"
  const { data: list } = useQuery({ queryKey: ["mailSettings"], queryFn: api.getMailSettings })

  const [provider, setProvider] = useState("resend")
  const [apiKey, setApiKey] = useState("")
  const [smtpHost, setSmtpHost] = useState("")
  const [smtpUser, setSmtpUser] = useState("")
  const [smtpPass, setSmtpPass] = useState("")
  const [defaultFrom, setDefaultFrom] = useState("")

  const save = useMutationToast({
    mutationFn: () => {
      if (provider === "resend") return api.setMailSettings({ provider: "resend", config: { apiKey }, enabled: true, defaultFrom })
      return api.setMailSettings({ provider: "smtp", config: { host: smtpHost, user: smtpUser, pass: smtpPass }, enabled: true, defaultFrom })
    },
    success: t('integrations.toast.saveSuccess'),
    invalidate: [["mailSettings"]],
  })

  const test = useMutationToast({
    mutationFn: () => api.testMail({ to: defaultFrom || "owner@example.com", from: defaultFrom || undefined, name: "Admin", locale }),
    success: t('integrations.mail.testSuccess'),
  })

  return (
    <PageContainer size="2xl">
      <PageHeader title={t('integrations.mail.pageTitle') || 'Mail Integration'} />
      <div className="mb-6">
        <Heading level="h3">{t('integrations.mail.configuredProviders') || 'Configured providers'}</Heading>
        {list?.map((l) => (
          <div key={l.id} className="p-3 border rounded mb-2">
            <div className="flex items-center justify-between">
              <div>
                <strong>{l.provider}</strong>
                <div className="text-sm text-ui-fg-muted">{l.enabled ? t('integrations.mail.enabled') || 'Enabled' : t('integrations.mail.disabled') || 'Disabled'}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Container className="p-6">
        <Heading level="h3" className="mb-3">{t('integrations.mail.configureProvider') || 'Configure provider'}</Heading>
        <div className="flex flex-col gap-3">
          <div>
            <Label size="small">{t('integrations.mail.providerLabel') || 'Provider'}</Label>
            <Select value={provider} onValueChange={(v: string) => setProvider(v)}>
              <Select.Trigger className="w-full">
                <Select.Value placeholder={t('integrations.mail.providerLabel') || 'Provider'} />
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="resend">Resend (API)</Select.Item>
                <Select.Item value="smtp">SMTP</Select.Item>
              </Select.Content>
            </Select>
          </div>

          {provider === "resend" && (
            <div>
              <Label size="small">{t('integrations.mail.apiKeyLabel') || 'API Key'}</Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
          )}

          {provider === "smtp" && (
            <>
              <div>
                <Label size="small">{t('integrations.mail.smtpHostLabel') || 'SMTP Host'}</Label>
                <Input placeholder="smtp.example.com" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} />
              </div>
              <div>
                <Label size="small">{t('integrations.mail.smtpUserLabel') || 'User'}</Label>
                <Input placeholder="username" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
              </div>
              <div>
                <Label size="small">{t('integrations.mail.smtpPassLabel') || 'Password'}</Label>
                <Input type="password" placeholder="(never shown again)" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} />
              </div>
            </>
          )}

          <div>
            <Label size="small">{t('integrations.mail.defaultFromLabel') || 'Default From'}</Label>
            <Input value={defaultFrom} onChange={(e) => setDefaultFrom(e.target.value)} placeholder="no-reply@example.com" />
            <Text size="xsmall" className="mt-1 text-ui-fg-muted">{t('integrations.mail.defaultFromHint') || 'Used as From for test emails.'}</Text>
          </div>

          <div className="flex gap-3">
            <Button onClick={() => save.mutate()} isLoading={save.isPending}>{t('integrations.mail.saveButton') || 'Save'}</Button>
            <Button onClick={() => test.mutate()} variant="secondary">{t('integrations.mail.testButton') || 'Send test'}</Button>
          </div>
        </div>
      </Container>
    </PageContainer>
  )
}
