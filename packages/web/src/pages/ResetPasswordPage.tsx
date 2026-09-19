import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button, Heading, Text, Input, Label } from "@medusajs/ui"

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState("")

  return (
    <div className="flex min-h-full w-full items-center justify-center bg-ui-bg-subtle px-4 py-8">
      <div className="w-full max-w-[390px]">

        {/* Logo */}
        <div className="mb-6 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-ui-bg-base shadow-sm">
            <div className="h-7 w-7 rounded-lg bg-ui-fg-base" />
          </div>
        </div>

        {/* Header */}
        <div className="mb-6 text-center">
          <Heading
            level="h1"
            className="mb-2 text-xl font-semibold text-ui-fg-base"
          >
            Initialiser le mot de passe
          </Heading>

          <Text className="text-sm leading-5 text-ui-fg-subtle">
            Entrez votre adresse e-mail et nous vous enverrons un lien
            pour initialiser votre mot de passe.
          </Text>
        </div>

        {/* Form */}
        <div className="flex flex-col gap-4">

          {/* Email */}
          <div>
            <Label
              size="small"
              className="mb-1.5 block text-ui-fg-subtle"
            >
              Email
            </Label>

            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seller@fotetsa.com"
              className="h-10 rounded-lg"
            />
          </div>

          {/* Button */}
          <Button
            className="mt-1 h-10 w-full rounded-lg"
            onClick={() => {
              alert("La réinitialisation du mot de passe est actuellement indisponible.")} }>
            Envoyer le lien
          </Button>

          {/* Back */}
          <div className="mt-2 text-center text-sm">
            <span className="text-ui-fg-subtle">
              Vous vous souvenez de votre mot de passe ?{" "}
            </span>

            <span
              className="cursor-pointer text-ui-fg-interactive"
              onClick={() => navigate("/")}
            >
              Retour à la connexion
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}