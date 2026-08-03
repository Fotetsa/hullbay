// SetupDomainPage.tsx
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { api } from "../lib/api"
import { useMutation } from "@tanstack/react-query"
import { useMe } from "../lib/useMe"

/**
 * Validation du domaine côté client (correspond à la validation backend)
 * Format: labels séparés par des points, TLD alphabétique >= 2 caractères
 */
function isValidDomain(value: string): boolean {
  // Regex simple pour valider le format de domaine
  const domainRegex = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.(?:[A-Za-z0-9-]{1,63}\.)*[A-Za-z]{2,}$/
  return domainRegex.test(value) && value.length <= 253
}

export function SetupDomainPage() {
  const navigate = useNavigate()
  const { me, isLoading: meLoading, isError: meError } = useMe()
  const [domain, setDomain] = useState("")
  const [domainError, setDomainError] = useState<string | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)

  // Mutation pour enregistrer le domaine
  const setDomainMutation = useMutation({
    mutationFn: (domain: string) => api.setDomain(domain),
    onSuccess: (data) => {
      toast.success("Domaine configuré avec succès", {
        description: "Redirection en cours..."
      })
      // Redirection vers l'URL fournie par le backend
      if (data.url && typeof window !== 'undefined') {
        window.location.href = data.url
      } else {
        // Fallback: redirection vers le dashboard
        navigate("/", { replace: true })
      }
    },
    onError: (error: Error) => {
      const message = error.message || "Impossible de configurer le domaine"
      if (message.toLowerCase().includes("mfa") || message.toLowerCase().includes("authentification")) {
        toast.error("MFA non activée", { description: "Active la MFA avant de configurer le domaine." })
        navigate("/activate-mfa")
        return
      }
      setBackendError(message)
      toast.error("Erreur", {
        description: message,
      })
    }
  })

  const handleDomainChange = (value: string) => {
    setDomain(value)
    setDomainError(null)
    setBackendError(null)

    // Validation en temps réel
    if (value.trim().length > 0 && !isValidDomain(value)) {
      setDomainError("Format de domaine invalide. Exemple: ops.mon-domaine.com")
    }
  }

  const handleSubmit = async () => {
    const trimmedDomain = domain.trim()

    // Validation avant envoi
    if (!trimmedDomain) {
      setDomainError("Le domaine est requis")
      return
    }

    if (!isValidDomain(trimmedDomain)) {
      setDomainError("Format de domaine invalide. Exemple: ops.mon-domaine.com")
      return
    }

    if (me && !me.mfaEnabled) {
      setBackendError("MFA non activée — active la MFA avant de configurer le domaine.")
      return
    }

    setDomainError(null)
    setBackendError(null)
    await setDomainMutation.mutateAsync(trimmedDomain)
  }

  const isLoading = setDomainMutation.status === "pending"

  // Bloquer l'enregistrement tant que la MFA n'est pas activée
  const mfaNotEnabled = Boolean(me && !me.mfaEnabled)

  useEffect(() => {
    if (me && me.mfaEnabled && backendError?.toLowerCase().includes("mfa")) {
      setBackendError(null)
    }
  }, [me, backendError])

  if (meLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
        <Container className="w-full max-w-md p-6">
          <Text>Vérification de la MFA en cours...</Text>
        </Container>
      </div>
    )
  }

  if (meError || !me) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
        <Container className="w-full max-w-md p-6">
          <Text className="text-ui-fg-error">
            Impossible de vérifier l'état de la MFA. Recharge la page ou reconnecte-toi.
          </Text>
        </Container>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
      <Container className="w-full max-w-md p-6">
        <Heading level="h1" className="mb-3">
          Configure ton domaine
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">
          Indique le domaine public que tu veux utiliser pour accéder à ton
          instance hullbay. Le domaine doit être valide et accessible.
        </Text>

        {meLoading ? null : mfaNotEnabled ? (
          <div className="mb-4 rounded-2xl bg-ui-bg-warning p-3">
            <Text className="text-ui-fg-error">MFA non activée — veillez l'activer</Text>
            <div className="mt-2">
              <Button variant="secondary" size="small" onClick={() => navigate('/activate-mfa')}>
                Activer la MFA
              </Button>
            </div>
          </div>
        ) : (
          <div className="mb-4 rounded-2xl bg-ui-bg-success p-3">
            <Text>MFA activée</Text>
          </div>
        )}
        <div className="flex flex-col gap-4">
          <div>
            <Label size="small">Domaine public</Label>
            <Input
              value={domain}
              onChange={(e) => handleDomainChange(e.target.value)}
              placeholder="ops.exemple.com"
              disabled={isLoading || mfaNotEnabled}
              className={domainError || backendError ? "border-ui-fg-error" : ""}
            />
            {(domainError || backendError) && (
              <Text size="small" className="mt-1 text-ui-fg-error">
                {domainError ?? backendError}
              </Text>
            )}
            <Text size="xsmall" className="mt-1 text-ui-fg-subtle">
              Format: nom-domaine.tld (ex: ops.monentreprise.com)
            </Text>
          </div>
          
          <Button
            onClick={handleSubmit}
            disabled={!domain.trim() || !!domainError || isLoading || mfaNotEnabled}
            isLoading={isLoading}
            className="self-start"
          >
            {isLoading ? "Configuration en cours..." : "Enregistrer le domaine"}
          </Button>

          {isLoading && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-ui-fg-base border-t-transparent" />
              <Text size="small" className="text-ui-fg-subtle">
                Configuration du domaine en cours...
              </Text>
            </div>
          )}
        </div>
      </Container>
    </div>
  )
}