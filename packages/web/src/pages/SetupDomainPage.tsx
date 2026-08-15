import { useState } from "react"
import { Button, Container, Heading, Input, Label, Text } from "@medusajs/ui"
import { useMe } from "../lib/useMe"
import { useTranslation } from "react-i18next"
import { ThemeToggle } from "../components/ThemeToggle/ThemeToggle";

export function SetupDomainPage() {
  const { t } = useTranslation()
  const { isLoading } = useMe()
  const [domain, setDomain] = useState("")
  const [saved, setSaved] = useState(false)

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Text className="text-ui-fg-subtle">{t('setupDomain.loading')}</Text>
      </div>
    )
  }

  const canSubmit = domain.trim().length > 0

  return (
    <div className="relative flex h-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Container className="w-full max-w-md p-6">
        <Heading level="h1" className="mb-3">
          {t('setupDomain.title')}
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">
          {t('setupDomain.description')}
        </Text>

        <div className="flex flex-col gap-4">
          <div>
            <Label size="small">{t('setupDomain.domainLabel')}</Label>
            <Input
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value)
                setSaved(false)
              }}
              placeholder={t('setupDomain.domainPlaceholder')}
            />
          </div>
          <Button
            onClick={() => setSaved(true)}
            disabled={!canSubmit}
            className="self-start"
          >
            {t('setupDomain.submitButton')}
          </Button>
          {saved && (
            <Text size="small" className="text-ui-fg-success">
              {t('setupDomain.successMessage')}
            </Text>
          )}
        </div>
      </Container>
    </div>
  )
}