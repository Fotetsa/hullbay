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
        toast.error("Impossible de démarrer l'activation MFA", { description: (e as Error).message })
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
      toast.error("Code invalide", { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle p-4">
      <Container className="w-[560px] p-6">
        <Heading level="h1" className="mb-4">
          Activer la double authentification
        </Heading>
        <Text className="text-ui-fg-subtle mb-4">
          Pour sécuriser ton compte, active la MFA en scannant le QR code ci-dessous
          (Google Authenticator, Authy, etc.) puis saisis le code.
        </Text>

        <div className="rounded-3xl bg-ui-bg-base p-5 shadow-sm mb-4">
          {otpauth ? (
            <div className="mx-auto flex w-full max-w-xs justify-center rounded-3xl p-4 ">
              <QRCodeSVG value={otpauth} size={180} marginSize={2} />
            </div>
          ) : (
            <Text className="text-ui-fg-muted">Préparation en cours...</Text>
          )}
        </div>

        <div className="rounded-3xl bg-ui-bg-base p-4 shadow-sm mb-4">
          <Label size="small" className="mb-1 block">
            Saisie manuelle (à copier)
          </Label>
          <Text size="small" className="text-ui-fg-subtle mb-2">
            Copie ce secret dans ton application si tu ne peux pas scanner.
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
              Copier
            </Button>
          </div>
        </div>

        <div className="rounded-3xl bg-ui-bg-base p-4 shadow-sm mb-4">
          <Label size="small">Code de vérification</Label>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" inputMode="numeric" className="mt-2" />
        </div>

        <div className="flex">
          <Button onClick={confirm} isLoading={loading} className="w-fit px-6 mx-auto" disabled={code.length !== 6}>
            Confirmer l'activation
          </Button>
        </div>
      </Container>
    </div>
  )
}
