import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { api, auth } from "../lib/api"

/**
 * Login en 2 temps : email/password puis, si MFA activée, code TOTP.
 * Conventions Medusa UI (Container/Heading/Input/Button).
 */
export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(false)

  async function submitCredentials() {
    setLoading(true)
    try {
      const res = await api.login(email, password)
      if (res.mfaRequired && res.pendingToken) {
        setPendingToken(res.pendingToken)
      } else if (res.token) {
        auth.set(res.token)
        onAuthed()
        navigate("/", { replace: true })
      }
    } catch (e) {
      toast.error("Connexion échouée", { description: (e as Error).message })
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
      toast.error("Code invalide", { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
      <Container className="w-[400px] p-6">
        <Heading level="h1" className="mb-1">
          Bozando Ops
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">Console d'infrastructure</Text>

        {!pendingToken ? (
          <div className="flex flex-col gap-3">
            <div>
              <Label size="small">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@bozando.com"
              />
            </div>
            <div>
              <Label size="small">Mot de passe</Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button onClick={submitCredentials} isLoading={loading} className="mt-2">
              Se connecter
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Text className="text-ui-fg-subtle">
              Saisis le code de ton application d'authentification.
            </Text>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
            />
            <Button onClick={submitMfa} isLoading={loading}>
              Valider
            </Button>
          </div>
        )}
      </Container>
    </div>
  )
}
