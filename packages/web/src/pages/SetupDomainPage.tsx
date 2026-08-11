

import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useMutation } from "@tanstack/react-query"
import { api } from "../lib/api"
import { useMe } from "../lib/useMe"
import { isValidDomain } from "../lib/validation"

export function SetupDomainPage() {
  const navigate = useNavigate()
  const { me, isLoading: meLoading, isError: meError } = useMe()
  const [domain, setDomain] = useState("")
  const [domainError, setDomainError] = useState<string | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)

  const setDomainMutation = useMutation({
    mutationFn: (domain: string) => api.setDomain(domain),
    onSuccess: (data) => {
      toast.success("Domaine configuré avec succès", {
        description: "Redirection en cours...",
      })

      if (data.url && typeof window !== "undefined") {
        window.location.href = data.url
      } else {
        navigate("/", { replace: true })
      }
    },
    onError: (error: Error & { code?: string }) => {
      const code = error.code
      const message = error.message || "Impossible de configurer le domaine"
      if (code === "mfa_not_enabled") {
        toast.error("MFA non activée", { description: "Active la MFA avant de configurer le domaine." })
        navigate("/activate-mfa")
        return
      }
      setBackendError(message)
      toast.error("Erreur", {
        description: message,
      })
    },
  })

  const handleDomainChange = (value: string) => {
    setDomain(value)
    setDomainError(null)
    setBackendError(null)

    if (value.trim().length > 0 && !isValidDomain(value)) {
      setDomainError("Format de domaine invalide. Exemple: ops.mon-domaine.com")
    }
  }

  const handleSubmit = async () => {
    const trimmedDomain = domain.trim()

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

  const isLoading = setDomainMutation.isPending
  const mfaNotEnabled = Boolean(me && !me.mfaEnabled)

  useEffect(() => {
    if (me && me.mfaEnabled && backendError) {
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
          Indique le domaine public que tu veux utiliser pour accéder à ton instance hullbay. Le domaine doit être
          valide et accessible.
        </Text>

        {mfaNotEnabled ? (
          <div className="mb-4 rounded-2xl bg-ui-bg-warning p-3">
            <Text className="text-ui-fg-error">MFA non activée — veillez l'activer</Text>
            <div className="mt-2">
              <Button variant="secondary" size="small" onClick={() => navigate("/activate-mfa")}>
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
