import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, auth } from "../lib/api"
import { Button, Heading, Text, Input, Label, toast, Container } from "@medusajs/ui"
import { useTranslation } from 'react-i18next'

/**
 * Login en 2 temps : email/password puis, si MFA activée, code TOTP.
 * Un compte sans MFA est renvoyé vers /activate-mfa par la MFA-gate (App.tsx) —
 * pas de modal d'enrôlement ici pour éviter le double parcours MFA.
 * Conventions Medusa UI (Container/Heading/Input/Button).
 */
export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [code, setCode] = useState("")

  async function submitCredentials() {
    setLoading(true)
    try {
      const res = await api.login(email, password)
      if (res.mfaRequired && res.pendingToken) {
        setPendingToken(res.pendingToken)
        return
      }
      if (res.token) {
        auth.set(res.token)
        onAuthed()
        navigate("/", { replace: true })
      }
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === "invalid_credentials") {
        toast.error(t('auth.toast.loginFailed'), { description: "Email ou mot de passe incorrect." })
      } else {
        toast.error(t('auth.toast.loginFailed'), { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  async function submitMfa() {
    if (!pendingToken) return
    setLoading(true)
    try {
      const res = await api.verifyMfa(pendingToken, code)
      auth.set(res.token)
      onAuthed()
      navigate("/", { replace: true })
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === "mfa_code_invalid" || err.code === "mfa_token_invalid") {
        toast.error(t('auth.toast.invalidCode'), { description: "Le code MFA est incorrect ou expiré." })
      } else {
        toast.error(t('auth.toast.invalidCode'), { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
      <Container className="w-[400px] p-6">
        <Heading level="h1" className="mb-1">
          {t('auth.title')}
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">{t('auth.subtitle')}</Text>

        {!pendingToken ? (
          <div className="flex flex-col gap-3">
            <div>
              <Label size="small">{t('auth.login.emailLabel')}</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('auth.login.placeholder')}
              />
            </div>
            <div>
              <Label size="small">{t('auth.login.passwordLabel')}</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button onClick={submitCredentials} isLoading={loading} className="mt-2">
              {t('auth.login.submitButton')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Text className="text-ui-fg-subtle">
              {t('auth.mfa.instruction')}
            </Text>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('auth.mfa.codePlaceholder')}
              inputMode="numeric"
            />
            <Button onClick={submitMfa} isLoading={loading}>
              {t('auth.mfa.submitButton')}
            </Button>
          </div>
        )}
      </Container>
    </div>
  )
}