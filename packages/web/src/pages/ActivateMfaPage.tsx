import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { api, auth } from "../lib/api"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { QRCodeSVG } from "qrcode.react"
import { useTranslation } from "react-i18next"

export function ActivateMfaPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const [secret, setSecret] = useState<string | null>(null)
  const [otpauth, setOtpauth] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true
    async function start() {
      try {
        const data = await api.enrollMfa()
        if (!mounted) return
        setSecret(data.secret)
        setOtpauth(data.otpauth)
      } catch (e) {
        const err = e as Error & { code?: string }
        toast.error(t('mfa.activate.toast.startError'), {
          description: err.code === "mfa_not_enabled" ? t('mfa.activate.toast.notEnabledDesc') : err.message,
        })
      }
    }
    start()
    return () => {
      mounted = false
    }
  }, [t])

  async function confirm() {
    setLoading(true)
    try {
      const res = await api.confirmMfa(code)
      if (res.token) {
        auth.set(res.token)
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] })
      toast.success(t('mfa.activate.toast.success'))
      window.location.assign("/")
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === "mfa_code_invalid" || err.code === "mfa_enrollment_missing") {
        toast.error(t('mfa.activate.toast.invalidCode'), { description: t('mfa.activate.toast.invalidCodeDesc') })
      } else {
        toast.error(t('mfa.activate.toast.invalidCode'), { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle p-4">
      <Container className="w-[560px] p-6">
        <Heading level="h1" className="mb-4">
          {t('mfa.activate.title')}
        </Heading>
        <Text className="text-ui-fg-subtle mb-4">
          {t('mfa.activate.description')}
        </Text>

        <div className="rounded-3xl bg-ui-bg-base p-5 shadow-sm mb-4">
          {otpauth ? (
            <div className="mx-auto flex w-full max-w-xs justify-center rounded-3xl p-4 ">
              <QRCodeSVG value={otpauth} size={180} marginSize={2} />
            </div>
          ) : (
            <Text className="text-ui-fg-muted">{t('mfa.activate.preparing')}</Text>
          )}
        </div>

        <div className="rounded-3xl bg-ui-bg-base p-4 shadow-sm mb-4">
          <Label size="small" className="mb-1 block">
            {t('mfa.activate.manualEntryTitle')}
          </Label>
          <Text size="small" className="text-ui-fg-subtle mb-2">
            {t('mfa.activate.manualEntryDesc')}
          </Text>
          <div className="flex items-center gap-3">
            <div className="flex-1 rounded-2xl bg-ui-bg-base-pressed p-3 text-sm font-mono break-all">
              {secret ?? "—"}
            </div>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                if (secret) navigator.clipboard.writeText(secret)
              }}
            >
              {t('mfa.activate.copyButton')}
            </Button>
          </div>
        </div>

        <div className="rounded-3xl bg-ui-bg-base p-4 shadow-sm mb-4">
          <Label size="small">{t('mfa.activate.verifyCodeLabel')}</Label>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" className="mt-2" />
        </div>

        <div className="flex">
          <Button onClick={confirm} isLoading={loading} className="w-fit px-6 mx-auto" disabled={code.length !== 6}>
            {t('mfa.activate.confirmButton')}
          </Button>
        </div>
      </Container>
    </div>
  )
}