import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text } from "@medusajs/ui"
import { api } from "../lib/api"
import { isValidDomain } from "../lib/validation"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"

/**
 * Page Paramètres utilisateur : profil + activation de la MFA (TOTP).
 * Enrôlement : on récupère le secret/otpauth, l'utilisateur l'ajoute à son app
 * d'authentification (saisie du secret), puis confirme avec un 1er code.
 */
export function SettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const changePw = useMutationToast({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    success: "Mot de passe modifié",
    onSuccess: () => {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    },
  })

<<<<<<< Updated upstream
=======
  const updateDomainMutation = useMutation({
    mutationFn: (domain: string) => api.setDomain(domain),
    onSuccess: (data) => {
      toast.success("Domaine mis à jour", {
        description: "Le domaine a été modifié avec succès"
      })
      setCurrentDomain(newDomain)
      queryClient.invalidateQueries({ queryKey: ["domain"] })
      
      if (data.url && typeof window !== 'undefined') {
        toast.info("Redirection possible", {
          description: `Le domaine a été changé vers ${data.url}`,
          action: {
            label: "Accéder",
            altText: "Rediriger vers le nouveau domaine",
            onClick: () => {
              window.location.href = data.url
            }
          }
        })
      }
    },
    onError: (error: Error) => {
      toast.error("Erreur", {
        description: error.message || "Impossible de modifier le domaine"
      })
    }
  })

  const enrollMfaMutation = useMutation({
    mutationFn: () => api.enrollMfa(),
    onSuccess: (data) => {
      setMfaSecret(data.secret)
      setMfaOtpauth(data.otpauth)
      setShowMfaModal(true)
      setMfaCode("")
    },
    onError: (error: Error & { code?: string }) => {
      const code = error.code
      toast.error("Erreur", {
        description:
          code === "mfa_not_enabled"
            ? "Active la MFA avant de poursuivre."
            : error.message || "Impossible de démarrer l'activation MFA",
      })
    }
  })

  const confirmMfaMutation = useMutation({
    mutationFn: (code: string) => api.confirmMfa(code),
    onSuccess: () => {
      toast.success("MFA activée", {
        description: "La double authentification est maintenant active"
      })
      queryClient.invalidateQueries({ queryKey: ["me"] })
      setShowMfaModal(false)
      setMfaSecret(null)
      setMfaOtpauth(null)
      setMfaCode("")
    },
    onError: (error: Error & { code?: string }) => {
      const code = error.code
      toast.error("Code invalide", {
        description:
          code === "mfa_code_invalid" || code === "mfa_enrollment_missing"
            ? "Le code de vérification est incorrect."
            : error.message || "Le code de vérification est incorrect",
      })
    }
  })

  const handleDomainChange = (value: string) => {
    setNewDomain(value)
    setDomainError(null)
    if (value.trim().length > 0 && !isValidDomain(value)) {
      setDomainError("Format de domaine invalide. Exemple: ops.mon-domaine.com")
    }
  }

>>>>>>> Stashed changes
  const pwMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const pwTooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmitPw =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword

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