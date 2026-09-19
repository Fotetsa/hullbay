import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { api, auth } from "../lib/api"
import {
  Button,
  Heading,
  Text,
  Input,
  Label,
  toast,
} from "@medusajs/ui"
import { useTranslation } from "react-i18next"

export function LoginPage({ onAuthed }: { onAuthed: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [pendingToken, setPendingToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [code, setCode] = useState("")

  async function submitCredentials() {
    setLoading(true)

    try {
      const res = await api.login(email, password)

      if (res.mfaRequired && res.pendingToken) {
        setPendingToken(res.pendingToken)
        return
      }

      if (res.token) {
        auth.set(res.token)
        onAuthed()
        navigate("/", { replace: true })
      }
    } catch (e) {
      const err = e as Error & { code?: string }

      if (err.code === "invalid_credentials") {
        toast.error(t("auth.toast.loginFailed"), {
          description: "Email ou mot de passe incorrect.",
        })
      } else {
        toast.error(t("auth.toast.loginFailed"), {
          description: err.message,
        })
      }
    } finally {
      setLoading(false)
    }
  }

  async function submitMfa() {
    if (!pendingToken) return

    setLoading(true)

    try {
      const res = await api.verifyMfa(pendingToken, code)

      auth.set(res.token)
      onAuthed()
      navigate("/", { replace: true })
    } catch (e) {
      const err = e as Error & { code?: string }

      if (
        err.code === "mfa_code_invalid" ||
        err.code === "mfa_token_invalid"
      ) {
        toast.error(t("auth.toast.invalidCode"), {
          description: "Le code MFA est incorrect ou expiré.",
        })
      } else {
        toast.error(t("auth.toast.invalidCode"), {
          description: err.message,
        })
      }
    } finally {
      setLoading(false)
    }
  }

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
          {t("auth.title")}
        </Heading>

        <Text className="text-sm leading-5 text-ui-fg-subtle">
          {t("auth.subtitle")}
        </Text>
      </div>

      {!pendingToken ? (
        <div className="flex flex-col gap-4">

          {/* Email */}
          <div>
            <Label
              size="small"
              className="mb-1.5 block text-ui-fg-subtle"
            >
              {t("auth.login.emailLabel")}
            </Label>

            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("auth.login.placeholder")}
              className="h-10 rounded-lg"
            />
          </div>

          {/* Password */}
          <div>
            <Label
              size="small"
              className="mb-1.5 block text-ui-fg-subtle"
            >
              {t("auth.login.passwordLabel")}
            </Label>

            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 rounded-lg"
            />
          </div>

          {/* Button */}
          <Button
            onClick={submitCredentials}
            isLoading={loading}
            className="mt-1 h-10 w-full rounded-lg"
          >
            {t("auth.login.submitButton")}
          </Button>

          {/* Secondary actions */}
          <div className="mt-2 flex flex-col items-center gap-2 text-sm">
            <div className="text-ui-fg-subtle">
              <span>Mot de passe oublié ? </span>
              <span
                className="cursor-pointer text-ui-fg-interactive"
                onClick={() => navigate("/reset-password")}>
                Initialiser le mot de passe
              </span>
            </div>

            <div className="text-ui-fg-subtle">
              <span>Pas encore de compte ? </span>
              <span
                className="cursor-pointer text-ui-fg-interactive"
                onClick={() => alert("La creation de compte est actuellementdesactivee.")}>
                Créer un compte
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">

          {/* MFA */}
          <div>
            <Label
              size="small"
              className="mb-1.5 block text-ui-fg-subtle"
            >
              Code de vérification
            </Label>

            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t("auth.mfa.codePlaceholder")}
              inputMode="numeric"
              className="h-10 rounded-lg text-center tracking-[0.25em]"
            />
          </div>

          <Button
            onClick={submitMfa}
            isLoading={loading}
            className="h-10 w-full rounded-lg"
          >
            {t("auth.mfa.submitButton")}
          </Button>
        </div>
      )}
    </div>
  </div>
)
}
