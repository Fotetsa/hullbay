import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { api, auth } from "../lib/api"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { QRCodeSVG } from "qrcode.react"

export function ActivateMfaPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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
        toast.error("Impossible de démarrer l'activation MFA", {
          description: err.code === "mfa_not_enabled" ? "Active d’abord la MFA avant de poursuivre." : err.message,
        })
      }
    }
    start()
    return () => {
      mounted = false
    }
  }, [])

  async function confirm() {
    setLoading(true)
    try {
      const res = await api.confirmMfa(code)
      if (res.token) {
        auth.set(res.token)
      }
      await queryClient.invalidateQueries({ queryKey: ["me"] })
      toast.success("MFA activée")
      window.location.assign("/")
    } catch (e) {
      const err = e as Error & { code?: string }
      if (err.code === "mfa_code_invalid" || err.code === "mfa_enrollment_missing") {
        toast.error("Code invalide", { description: "Le code MFA est incorrect." })
      } else {
        toast.error("Code invalide", { description: err.message })
      }
    } finally {
      setLoading(false)
    }
  }

  return (
  <div className="flex min-h-full w-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
    <div className="w-full max-w-[390px]">

      {/* Logo */}
      <div className="mb-6 flex justify-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ui-bg-base shadow-sm">
          <div className="h-7 w-7 rounded-lg bg-ui-fg-base" />
        </div>
      </div>

      {/* Header */}
      <div className="mb-6 text-center">
        <Heading
          level="h1"
          className="mb-2 text-xl font-semibold text-ui-fg-base"
        >
          Activer la double authentification
        </Heading>

        <Text className="text-sm leading-5 text-ui-fg-subtle">
          Sécurisez votre compte en activant la MFA. Scannez le QR code
          avec votre application d'authentification puis saisissez le code
          affiché.
        </Text>
      </div>

      {/* QR Code */}
      <div className="mb-4 rounded-xl bg-ui-bg-base p-5 shadow-sm">
        <div className="mb-3 text-center">
          <Text className="text-sm font-medium text-ui-fg-base">
            Scannez le QR code
          </Text>
        </div>

        <div className="flex justify-center">
          {otpauth ? (
            <div className="flex items-center justify-center rounded-xl bg-white p-4">
              <QRCodeSVG value={otpauth} size={180} marginSize={2} />
            </div>
          ) : (
            <div className="flex h-[212px] items-center justify-center">
              <Text className="text-sm text-ui-fg-muted">
                Préparation en cours...
              </Text>
            </div>
          )}
        </div>

        <Text className="mt-3 text-center text-xs text-ui-fg-subtle">
          Utilisez Google Authenticator, Authy ou une application
          compatible avec la validation en deux étapes.
        </Text>
      </div>

      {/* Secret */}
      <div className="mb-4 rounded-xl bg-ui-bg-base p-4 shadow-sm">
        <Label
          size="small"
          className="mb-1.5 block text-ui-fg-subtle"
        >
          Configuration manuelle
        </Label>

        <Text className="mb-3 text-xs text-ui-fg-subtle">
          Si vous ne pouvez pas scanner le QR code, copiez ce secret
          dans votre application.
        </Text>

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 rounded-lg bg-ui-bg-base-pressed p-3 text-xs font-mono break-all text-ui-fg-base">
            {secret ?? "—"}
          </div>

          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              if (secret) {
                navigator.clipboard.writeText(secret)
              }
            }}
          >
            Copier
          </Button>
        </div>
      </div>

      {/* Verification code */}
      <div className="mb-5 rounded-xl bg-ui-bg-base p-4 shadow-sm">
        <Label
          size="small"
          className="mb-1.5 block text-ui-fg-subtle"
        >
          Code de vérification
        </Label>

        <Text className="mb-3 text-xs text-ui-fg-subtle">
          Saisissez le code à 6 chiffres affiché dans votre application.
        </Text>

        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456"
          inputMode="numeric"
          maxLength={6}
          className="h-10 rounded-lg text-center text-base tracking-[0.3em]"
        />
      </div>

      {/* Confirm */}
      <Button
        onClick={confirm}
        isLoading={loading}
        disabled={code.length !== 6}
        className="h-10 w-full rounded-lg"
      >
        Confirmer l'activation
      </Button>
    </div>
  </div>
)
}
