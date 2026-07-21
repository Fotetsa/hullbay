import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Container, Heading, Input, Label, Text } from "@medusajs/ui"
import { useMe } from "../lib/useMe"

export function SetupDomainPage() {
  const navigate = useNavigate()
  const { me, isLoading } = useMe()
  const [domain, setDomain] = useState("")
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (me) {
      setDomain(me.domain ?? "")
    }
  }, [me])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-ui-bg-subtle">
        <Text className="text-ui-fg-subtle">Chargement…</Text>
      </div>
    )
  }

  const canSubmit = domain.trim().length > 0

  return (
    <div className="flex h-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
      <Container className="w-full max-w-md p-6">
        <Heading level="h1" className="mb-3">
          Configure ton domaine
        </Heading>
        <Text className="text-ui-fg-subtle mb-6">
          Indique le domaine public que tu veux utiliser pour accéder à ton
          instance Bozando Ops.
        </Text>

        <div className="flex flex-col gap-4">
          <div>
            <Label size="small">Domaine public</Label>
            <Input
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value)
                setSaved(false)
              }}
              placeholder="ops.exemple.com"
            />
          </div>
          <Button
            onClick={() => setSaved(true)}
            disabled={!canSubmit}
            className="self-start"
          >
            Enregistrer le domaine
          </Button>
          {saved && (
            <Text size="small" className="text-ui-fg-success">
              Domaine prêt à être envoyé au backend.
            </Text>
          )}
        </div>
      </Container>
    </div>
  )
}