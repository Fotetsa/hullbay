import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { ShieldCheck } from "@medusajs/icons"
import { api, auth } from "../lib/api"

/**
 * Écran d'amorçage (installation neuve) : crée le 1er compte owner quand aucun
 * utilisateur n'existe encore. Sans cet écran, un déploiement neuf restait bloqué
 * sur le login sans aucun moyen de créer un compte depuis l'UI (il fallait curler).
 * Après création, on connecte directement l'owner.
 */
export function BootstrapPage({ onAuthed }: { onAuthed: () => void }) {
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
      // Après création, connecter automatiquement l'owner
      const loginRes = await api.login(email, password)
      if (loginRes.token) {
        auth.set(loginRes.token)
        toast.success("Compte créé et connecté")
        onAuthed()
      } else {
        toast.success("Compte créé", { description: "Connecte-toi." })
        navigate("/login", { replace: true })
      }
    } catch (e) {
      toast.error("Création impossible", { description: (e as Error).message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle p-4">
      <Container className="w-[440px] p-6">
        <div className="mb-1 flex items-center gap-2">
          <ShieldCheck />
          <Heading level="h1">Bienvenue sur hullbay</Heading>
        </div>
        <Text className="mb-6 text-ui-fg-subtle">
          Aucun compte n'existe encore. Crée le compte administrateur (owner) qui
          pilotera l'infrastructure. Tu pourras ensuite déléguer un accès limité à un
          employé et activer la double authentification.
        </Text>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) submit()
          }}
        >
          <div>
            <Label size="small">Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@bozando.com"
              autoComplete="username"
            />
          </div>
          <div>
            <Label size="small">Mot de passe</Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="8 caractères minimum"
            />
            {tooShort && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                Au moins 8 caractères.
              </Text>
            )}
          </div>
          <div>
            <Label size="small">Confirmer le mot de passe</Label>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {mismatch && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                Les mots de passe ne correspondent pas.
              </Text>
            )}
          </div>
          <Button type="submit" isLoading={loading} disabled={!canSubmit} className="mt-2">
            Créer le compte administrateur
          </Button>
        </form>
      </Container>
    </div>
  )
}
