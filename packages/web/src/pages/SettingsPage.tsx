import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text } from "@medusajs/ui"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"

/**
 * Page Paramètres utilisateur : profil + activation de la MFA (TOTP).
 * Enrôlement : on récupère le secret/otpauth, l'utilisateur l'ajoute à son app
 * d'authentification (saisie du secret), puis confirme avec un 1er code.
 */
export function SettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })

  const [secret, setSecret] = useState<string | null>(null)
  const [otpauth, setOtpauth] = useState<string | null>(null)
  const [code, setCode] = useState("")

  // Changement de mot de passe.
  const [domain, setDomain] = useState("")
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const updateDomain = useMutationToast({
    mutationFn: () => api.setDomain(domain.trim()),
    success: "Domaine mis à jour",
    invalidate: [["me"]],
  })

  const changePw = useMutationToast({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    success: "Mot de passe modifié",
    onSuccess: () => {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    },
  })

  const pwMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const pwTooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmitPw =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword
  const canSaveDomain = domain.trim().length > 0

  useEffect(() => {
    if (me) {
      setDomain(me.domain ?? "")
    }
  }, [me])

  return (
    <PageContainer size="2xl">
      <PageHeader title="Paramètres" />

      {/* Profil */}
      <Container className="mb-4 p-6">
        <Heading level="h3" className="mb-3">
          Compte
        </Heading>
        <div className="flex flex-col gap-2">
          <div>
            <Label size="small">Email</Label>
            <Text>{me?.email ?? "…"}</Text>
          </div>
          <div>
            <Label size="small">Rôle</Label>
            <Text className="capitalize">{me?.role ?? "…"}</Text>
          </div>
          <div>
            <Label size="small">Domaine public</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="ops.exemple.com"
            />
            <Button
              onClick={() => updateDomain.mutate()}
              isLoading={updateDomain.isPending}
              disabled={!canSaveDomain}
              className="mt-3 self-start"
            >
              Enregistrer
            </Button>
          </div>
        </div>
      </Container>

      {/* Mot de passe */}
      <Container className="mb-4 p-6">
        <Heading level="h3" className="mb-3">
          Mot de passe
        </Heading>
        <div className="flex flex-col gap-3">
          <div>
            <Label size="small">Mot de passe actuel</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div>
            <Label size="small">Nouveau mot de passe</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="8 caractères minimum"
            />
            {pwTooShort && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                Au moins 8 caractères.
              </Text>
            )}
          </div>
          <div>
            <Label size="small">Confirmer le nouveau mot de passe</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            {pwMismatch && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                Les mots de passe ne correspondent pas.
              </Text>
            )}
          </div>
          <Button
            onClick={() => changePw.mutate()}
            isLoading={changePw.isPending}
            disabled={!canSubmitPw}
            className="self-start"
          >
            Changer le mot de passe
          </Button>
        </div>
      </Container>

    </PageContainer>
  )
}