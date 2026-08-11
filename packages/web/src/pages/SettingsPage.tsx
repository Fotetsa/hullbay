// SettingsPage.tsx - Version complète et corrigée
import { useEffect, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { QRCodeSVG } from "qrcode.react"
import { api } from "../lib/api"
import { isValidDomain } from "../lib/validation"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"

export function SettingsPage() {
  const queryClient = useQueryClient()
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
  })

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const [currentDomain, setCurrentDomain] = useState("")
  const [newDomain, setNewDomain] = useState("")
  const [domainError, setDomainError] = useState<string | null>(null)

  const [showMfaModal, setShowMfaModal] = useState(false)
  const [mfaSecret, setMfaSecret] = useState<string | null>(null)
  const [mfaOtpauth, setMfaOtpauth] = useState<string | null>(null)
  const [mfaCode, setMfaCode] = useState("")
  const [copied, setCopied] = useState(false)

  const { data: domainData } = useQuery({
    queryKey: ["domain"],
    queryFn: api.getDomain,
    enabled: !!me && me.role === "owner",
    retry: false,
  })

  useEffect(() => {
    if (domainData?.domain) {
      setCurrentDomain(domainData.domain)
      setNewDomain(domainData.domain)
    }
  }, [domainData])

  const changePw = useMutationToast({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    success: "Mot de passe modifié avec succès",
    onSuccess: () => {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    },
  })

  const updateDomainMutation = useMutation({
    mutationFn: (domain: string) => api.setDomain(domain),
    onSuccess: (data: { ok: boolean; url?: string }) => {
      toast.success("Domaine mis à jour", {
        description: "Le domaine a été modifié avec succès",
      })
      setCurrentDomain(newDomain)
      queryClient.invalidateQueries({ queryKey: ["domain"] })

      if (data.url && typeof window !== "undefined") {
        toast.info("Redirection possible", {
          description: `Le domaine a été changé vers ${data.url}`,
          action: {
            label: "Accéder",
            altText: "Rediriger vers le nouveau domaine",
            onClick: () => {
              if (data.url) window.location.href = data.url
            },
          },
        })
      }
    },
    onError: (error: Error) => {
      toast.error("Erreur", {
        description: error.message || "Impossible de modifier le domaine",
      })
    },
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
    },
  })

  const confirmMfaMutation = useMutation({
    mutationFn: (code: string) => api.confirmMfa(code),
    onSuccess: () => {
      toast.success("MFA activée", {
        description: "La double authentification est maintenant active",
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
    },
  })

  const handleDomainChange = (value: string) => {
    setNewDomain(value)
    setDomainError(null)
    if (value.trim().length > 0 && !isValidDomain(value)) {
      setDomainError("Format de domaine invalide. Exemple: ops.mon-domaine.com")
    }
  }

  const pwMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const pwTooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmitPw =
    currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword

  const canSubmitDomain =
    newDomain.trim().length > 0 && !domainError && newDomain !== currentDomain && !updateDomainMutation.isPending

  const copyToClipboard = async (text: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      } else {
        const textArea = document.createElement("textarea")
        textArea.value = text
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand("copy")
        document.body.removeChild(textArea)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    } catch {
      toast.error("Erreur", {
        description: "Impossible de copier le texte",
      })
    }
  }

  if (!me) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Text className="text-ui-fg-subtle">Chargement...</Text>
      </div>
    )
  }

  return (
    <PageContainer size="2xl">
      <PageHeader title="Paramètres" />

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
            <Label size="small">Double authentification</Label>
            <div className="flex items-center gap-3">
              <Text>{me.mfaEnabled ? " Activée" : " Désactivée"}</Text>
              {!me.mfaEnabled && (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => enrollMfaMutation.mutate()}
                  isLoading={enrollMfaMutation.isPending}
                >
                  Activer la MFA
                </Button>
              )}
            </div>
          </div>
        </div>
      </Container>

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

      {me?.role === "owner" && (
        <Container className="mb-4 p-6">
          <Heading level="h3" className="mb-3">
            Domaine public
          </Heading>
          <Text className="text-ui-fg-subtle mb-3">
            Modifier le domaine public de votre instance.
            {currentDomain && ` Actuel: ${currentDomain}`}
          </Text>
          <div className="flex flex-col gap-3">
            <div>
              <Label size="small">Nouveau domaine</Label>
              <Input
                value={newDomain}
                onChange={(e) => handleDomainChange(e.target.value)}
                placeholder="ops.mon-domaine.com"
                disabled={updateDomainMutation.isPending}
                className={domainError ? "border-ui-fg-error" : ""}
              />
              {domainError && (
                <Text size="xsmall" className="mt-1 text-ui-fg-error">
                  {domainError}
                </Text>
              )}
              <Text size="xsmall" className="mt-1 text-ui-fg-subtle">
                Format: nom-domaine.tld (ex: ops.monentreprise.com)
              </Text>
            </div>
            <Button
              onClick={() => updateDomainMutation.mutate(newDomain || "")}
              disabled={!canSubmitDomain}
              isLoading={updateDomainMutation.isPending}
              className="self-start"
            >
              {updateDomainMutation.isPending ? "Mise à jour..." : "Modifier le domaine"}
            </Button>
          </div>
        </Container>
      )}
    </PageContainer>
  )
}
