import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text, toast } from "@medusajs/ui"
import { useMutation } from "@tanstack/react-query"
import { api } from "../lib/api"
import { useMe } from "../lib/useMe"
import { isValidDomain } from "../lib/validation"
import { useTranslation } from "react-i18next"

export function SetupDomainPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { isLoading } = useMe()
  const [domain, setDomain] = useState("")
  const [domainError, setDomainError] = useState<string | null>(null)

  const setDomainMutation = useMutation({
    mutationFn: (value: string) => api.setDomain(value),
    onSuccess: (data) => {
      toast.success(t("setupDomain.successMessage"))
      // Dev : pas de domaine public résolvable et pas de changement d'origine
      // (le token localStorage est scoped à l'origine) — on reste dans l'app.
      // Le domaine est quand même persisté côté backend.
      if (import.meta.env.DEV) {
        navigate("/", { replace: true })
        return
      }
      if (data.url && typeof window !== "undefined") {
        window.location.href = data.url
      } else {
        navigate("/", { replace: true })
      }
    },
    onError: (error: Error & { code?: string }) => {
      if (error.code === "mfa_not_enabled") {
        toast.error(t("setupDomain.mfaRequired"))
        navigate("/activate-mfa")
        return
      }
      toast.error(t("setupDomain.saveFailed"), {
        description: error.message,
      })
    },
  })

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Text className="text-ui-fg-subtle">{t("setupDomain.loading")}</Text>
      </div>
    )
  }

  const handleDomainChange = (value: string) => {
    setDomain(value)
    setDomainError(null)
    if (value.trim().length > 0 && !isValidDomain(value)) {
      setDomainError(t("setupDomain.invalidDomain"))
    }
  }

  const isPending = setDomainMutation.isPending
  const canSubmit = domain.trim().length > 0 && isValidDomain(domain) && !isPending

  const handleSubmit = async () => {
    const trimmedDomain = domain.trim()
    if (!isValidDomain(trimmedDomain)) {
      setDomainError(t("setupDomain.invalidDomain"))
      return
    }
    setDomainError(null)
    await setDomainMutation.mutateAsync(trimmedDomain)
  }

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
      <Container className="w-full max-w-md p-6">
        <Heading level="h1" className="mb-3">
          {t("setupDomain.title")}
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">
          {t("setupDomain.description")}
        </Text>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
        >
          <div>
            <Label size="small">{t("setupDomain.domainLabel")}</Label>
            <Input
              value={domain}
              onChange={(e) => handleDomainChange(e.target.value)}
              placeholder={t("setupDomain.domainPlaceholder")}
            />
            {domainError && (
              <Text size="small" className="text-ui-fg-error mt-1">
                {domainError}
              </Text>
            )}
          </div>
          <Button
            type="submit"
            disabled={!canSubmit}
            isLoading={isPending}
            className="self-start"
          >
            {isPending ? t("setupDomain.saving") : t("setupDomain.submitButton")}
          </Button>
        </form>
      </Container>
    </div>
  )
}
