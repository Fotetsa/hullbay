import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { ShieldCheck } from "@medusajs/icons"
import { api, auth } from "../lib/api"
import { useTranslation } from 'react-i18next'

/**
 * Écran d'amorçage (installation neuve) : crée le 1er compte owner quand aucun
 * utilisateur n'existe encore.
 */
export function BootstrapPage({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [loading, setLoading] = useState(false)

  const tooShort = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && confirm !== password
  const canSubmit = email.includes("@") && password.length >= 8 && password === confirm

  async function submit() {
    setLoading(true)
    try {
      await api.bootstrap(email, password)
      const res = await api.login(email, password)
      if (res.token) {
        auth.set(res.token)
        onAuthed()
        navigate("/", { replace: true })
      } else {
        toast.success(t('bootstrap.toast.accountCreated'), { description: t('bootstrap.toast.pleaseLogin') })
        navigate("/login", { replace: true })
      }
    } catch (e) {
      toast.error(t('bootstrap.toast.creationFailed'), { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle p-4">
      <Container className="w-[440px] p-6">
        <div className="mb-1 flex items-center gap-2">
          <ShieldCheck />
          <Heading level="h1">{t('bootstrap.title')}</Heading>
        </div>
        <Text className="mb-6 text-ui-fg-subtle">
          {t('bootstrap.description')}
        </Text>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) submit()
          }}
        >
          <div>
            <Label size="small">{t('bootstrap.emailLabel')}</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('bootstrap.emailPlaceholder')}
              autoComplete="username"
            />
          </div>
          <div>
            <Label size="small">{t('bootstrap.passwordLabel')}</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={t('bootstrap.passwordPlaceholder')}
            />
            {tooShort && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                {t('bootstrap.minCharsError')}
              </Text>
            )}
          </div>
          <div>
            <Label size="small">{t('bootstrap.confirmPasswordLabel')}</Label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {mismatch && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                {t('bootstrap.mismatchError')}
              </Text>
            )}
          </div>
          <Button type="submit" isLoading={loading} disabled={!canSubmit} className="mt-2">
            {t('bootstrap.submitButton')}
          </Button>
        </form>
      </Container>
    </div>
  )
}