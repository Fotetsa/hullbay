import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, auth } from "../lib/api"
import { Button, FocusModal, Heading, Text, Input, Label, toast, Container } from "@medusajs/ui"
import { QRCodeSVG } from "qrcode.react"
import { useTranslation } from 'react-i18next'

/**
 * Login en 2 temps : email/password puis, si MFA activée, code TOTP.
 * Conventions Medusa UI (Container/Heading/Input/Button).
 */
export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loginToken, setLoginToken] = useState<string | null>(null)

  const [secret, setSecret] = useState<string | null>(null)
  const [otpauth, setOtpauth] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [copied, setCopied] = useState(false)

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
        const me = await api.me()
        if (me.mfaEnabled) {
          onAuthed()
          navigate("/", { replace: true })
        } else {
          setLoginToken(res.token)
          setPendingToken(null)
          await loadMfaActivation()
        }
      }
    } catch (e) {
      toast.error(t('login.toast.loginFailed'), { description: (e as Error).message })
      const err = e as Error & { code?: string }
      if (err.code === "invalid_credentials") {
        toast.error("Connexion échouée", { description: "Email ou mot de passe incorrect." })
      } else {
        toast.error("Connexion échouée", { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  async function loadMfaActivation() {
    try {
      const activation = await api.enrollMfa()
      setSecret(activation.secret)
      setOtpauth(activation.otpauth)
      setCode("")
    } catch (e) {
      toast.error(t('login.toast.mfaEnrollFailed'), {
        description: (e as Error).message,
      })
      setLoginToken(null)
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
      toast.error(t('login.toast.invalidCode'), { description: (e as Error).message })
      const err = e as Error & { code?: string }
      if (err.code === "mfa_code_invalid" || err.code === "mfa_token_invalid") {
        toast.error("Code invalide", { description: "Le code MFA est incorrect ou expiré." })
      } else {
        toast.error("Code invalide", { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  async function confirmActivation() {
    if (!loginToken) return
    setLoading(true)
    try {
      const res = await api.confirmMfa(code)
      auth.set(res.token)
      onAuthed()
      setLoginToken(null)
      setSecret(null)
      setOtpauth(null)
      setCode("")
      navigate("/", { replace: true })
    } catch (e) {
      toast.error(t('login.toast.invalidCode'), { description: (e as Error).message })
      const err = e as Error & { code?: string }
      if (err.code === "mfa_code_invalid" || err.code === "mfa_enrollment_missing") {
        toast.error("Code invalide", { description: "Le code de confirmation MFA est incorrect." })
      } else {
        toast.error("Code invalide", { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
      <Container className="w-[400px] p-6">
        <Heading level="h1" className="mb-1">
          hullbay
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">{t('login.subtitle')}</Text>

        {!pendingToken ? (
          <div className="flex flex-col gap-3">
            <div>
              <Label size="small">{t('login.emailLabel')}</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('login.emailPlaceholder')}
              />
            </div>
            <div>
              <Label size="small">{t('login.passwordLabel')}</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button onClick={submitCredentials} isLoading={loading} className="mt-2">
              {t('login.submitButton')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Text className="text-ui-fg-subtle">
              {t('login.mfaStepDescription')}
            </Text>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
            />
            <Button onClick={submitMfa} isLoading={loading}>
              {t('login.verifyButton')}
            </Button>
          </div>
        )}

        <FocusModal open={!!loginToken} onOpenChange={(open) => !open && setLoginToken(null)}>
          <FocusModal.Content>
            <FocusModal.Header>
              <Heading level="h2">{t('login.mfaModal.title')}</Heading>
            </FocusModal.Header>
            <FocusModal.Body className="overflow-y-auto px-4 py-8">
              <div className="mx-auto flex w-full max-w-[520px] flex-col gap-5">
                <div className="rounded-3xl bg-ui-bg-base p-5 shadow-sm">
                  <Text className="text-ui-fg-subtle mb-3">
                    {t('login.mfaModal.description')}
                  </Text>
                  {otpauth ? (
                    <div className="mx-auto flex w-full max-w-xs justify-center rounded-3xl p-4 ">
                      <QRCodeSVG value={otpauth} size={180} marginSize={2} />
                    </div>
                  ) : (
                    <Text className="text-ui-fg-muted mb-4">{t('login.mfaModal.preparing')}</Text>
                  )}
                </div>

                <div className="rounded-3xl bg-ui-bg-base p-4 shadow-sm">
                  <div className="mb-3">
                    <Label size="small" className="mb-1 block">
                      {t('login.mfaModal.manualEntryLabel')}
                    </Label>
                    <Text size="small" className="text-ui-fg-subtle">
                      {t('login.mfaModal.manualEntryHint')}
                    </Text>
                  </div>
                  <div className="flex flex-col gap-1 rounded-2xl bg-ui-bg-base-pressed p-3 text-sm text-ui-fg-base">
                    <div className="min-h-[10px] break-all font-mono leading-6">
                      {secret ?? "—"}
                    </div>
                    <Button
                      variant="secondary"
                      size="small"
                      className="self-end"
                      onClick={() => {
                        if (secret) {
                          navigator.clipboard.writeText(secret)
                          setCopied(true)
                          window.setTimeout(() => setCopied(false), 1500)
                        }
                      }}
                    >
                      {copied ? t('login.mfaModal.copied') : t('login.mfaModal.copy')}
                    </Button>
                  </div>
                </div>

                <div className="rounded-3xl bg-ui-bg-base p-4 shadow-sm">
                  <Label size="small">{t('login.mfaModal.verificationCodeLabel')}</Label>
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    inputMode="numeric"
                    className="mt-2"
                  />
                </div>

                <div className="flex">
                  <Button onClick={confirmActivation} isLoading={loading} className="w-fit px-6 mx-auto">
                    {t('login.mfaModal.confirmButton')}
                  </Button>
                </div>
              </div>
            </FocusModal.Body>
          </FocusModal.Content>
        </FocusModal>
      </Container>
    </div>
  )
}