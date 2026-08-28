import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text } from "@medusajs/ui"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { useTranslation } from "react-i18next"
import { LanguageSwitch } from "../components/LanguageSwitch"
import { useNavigate } from "react-router-dom";

/**
 * Page Paramètres utilisateur : profil + activation de la MFA (TOTP).
 * Enrôlement : on récupère le secret/otpauth, l'utilisateur l'ajoute à son app
 * d'authentification (saisie du secret), puis confirme avec un 1er code.
 */
export function SettingsPage() {
  const { t } = useTranslation()
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const changePw = useMutationToast({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    success: t('settings.toast.passwordChanged'),
    onSuccess: () => {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    },
  })

  const navigate = useNavigate();
  const { data: envData } = useQuery({
    queryKey: ["environment"],
    queryFn: api.getEnvironment,
  });
  const isProduction = envData?.environment === "production";

  const pwMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const pwTooShort = newPassword.length > 0 && newPassword.length < 8
  const canSubmitPw =
    currentPassword.length > 0 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword

  return (
    <PageContainer size="2xl">
      <PageHeader title={t("settings.pageTitle")} />

      {/* Profil */}
      <Container className="mb-4 p-6">
        <Heading level="h3" className="mb-3">
          {t("settings.account.title")}
        </Heading>
        <div className="flex flex-col gap-2">
          <div>
            <Label size="small">{t("settings.account.emailLabel")}</Label>
            <Text>{me?.email ?? "…"}</Text>
          </div>
          <div>
            <Label size="small">{t("settings.account.roleLabel")}</Label>
            <Text className="capitalize">{me?.role ?? "…"}</Text>
          </div>
        </div>
      </Container>

      {/* Langue */}
      <Container className="mb-4 p-6">
        <Heading level="h3" className="mb-3">
          {t("settings.language.title")}
        </Heading>
        <div className="flex flex-col gap-2">
          <Label size="small">{t("settings.language.selectLabel")}</Label>
          <div className="w-48">
            <LanguageSwitch />
          </div>
          <Text size="xsmall" className="text-ui-fg-muted">
            {t("settings.language.hint")}
          </Text>
        </div>
      </Container>

      {/* Mot de passe */}
      <Container className="mb-4 p-6">
        <Heading level="h3" className="mb-3">
          {t("settings.password.title")}
        </Heading>
        <div className="flex flex-col gap-3">
          <div>
            <Label size="small">{t("settings.password.currentLabel")}</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div>
            <Label size="small">{t("settings.password.newLabel")}</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={t("settings.password.newPlaceholder")}
            />
            {pwTooShort && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                {t("settings.password.tooShortError")}
              </Text>
            )}
          </div>
          <div>
            <Label size="small">{t("settings.password.confirmLabel")}</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            {pwMismatch && (
              <Text size="xsmall" className="mt-1 text-ui-fg-error">
                {t("settings.password.mismatchError")}
              </Text>
            )}
          </div>
          <Button
            onClick={() => changePw.mutate()}
            isLoading={changePw.isPending}
            disabled={!canSubmitPw}
            className="self-start"
          >
            {t("settings.password.submitButton")}
          </Button>
        </div>
      </Container>

      {!isProduction && (
        <Container className="mb-4 p-6">
          <Heading level="h3" className="mb-3">
            {t("settings.domain.title")}
          </Heading>
          <Text size="small" className="text-ui-fg-subtle mb-3">
            {t("settings.domain.hint")}
          </Text>
          <Button variant="secondary" onClick={() => navigate("/setup-domain")}>
            {t("settings.domain.configureButton")}
          </Button>
        </Container>
      )}
    </PageContainer>
  );
}