import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Container, Heading, Input, Label, Text, Badge } from "@medusajs/ui"
import { ShieldCheck, CheckCircleSolid } from "@medusajs/icons"
import { QRCodeSVG } from "qrcode.react"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { PageHeader, PageContainer } from "../components/PageHeader"

/**
 * Page Paramètres utilisateur : profil + activation de la MFA (TOTP).
 * Enrôlement : on récupère le secret/otpauth, l'utilisateur l'ajoute à son app
 * d'authentification (saisie du secret), puis confirme avec un 1er code.
 */
export function SettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: api.me })

  const [secret, setSecret] = useState<string | null>(null)
  const [otpauth, setOtpauth] = useState<string | null>(null)
  const [code, setCode] = useState("")

  // Changement de mot de passe.
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const enroll = useMutationToast({
    mutationFn: api.enrollMfa,
    onSuccess: (r) => {
      setSecret(r.secret)
      setOtpauth(r.otpauth)
    },
  })

  const confirm = useMutationToast({
    mutationFn: () => api.confirmMfa(code),
    success: "MFA activée",
    invalidate: [["me"]],
    errorTitle: "Code invalide",
    onSuccess: () => {
      setSecret(null)
      setOtpauth(null)
      setCode("")
    },
  })

  const changePw = useMutationToast({
    mutationFn: () => api.changePassword(currentPassword, newPassword),
    success: "Mot de passe modifié",
    onSuccess: () => {
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
    },
  })

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

      {/* MFA */}
      <Container className="p-6">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck />
            <Heading level="h3">Double authentification</Heading>
          </div>
          {me?.mfaEnabled ? (
            <Badge color="green">
              <CheckCircleSolid /> Activée
            </Badge>
          ) : (
            <Badge color="orange">Désactivée</Badge>
          )}
        </div>

        {me?.mfaEnabled ? (
          <Text className="text-ui-fg-subtle">
            La double authentification est active sur ton compte. Un code te sera
            demandé à chaque connexion.
          </Text>
        ) : !secret ? (
          <div>
            <Text className="mb-3 text-ui-fg-subtle">
              Protège l'accès à la console (qui pilote ton infrastructure) avec un
              second facteur via une app d'authentification.
            </Text>
            <Button onClick={() => enroll.mutate()} isLoading={enroll.isPending}>
              Activer la MFA
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Text className="text-ui-fg-subtle">
              Scanne ce QR code avec ton app d'authentification (Google
              Authenticator, Authy…), puis saisis le code généré.
            </Text>
            {otpauth && (
              <div className="flex justify-center rounded-lg border border-ui-border-base bg-ui-bg-base p-4">
                <QRCodeSVG value={otpauth} size={200} marginSize={2} />
              </div>
            )}
            <div>
              <Label size="small">Saisie manuelle (si tu ne peux pas scanner)</Label>
              <Input readOnly value={secret} className="font-mono" />
            </div>
            <div>
              <Label size="small">Code de vérification</Label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
              />
            </div>
            <Button onClick={() => confirm.mutate()} isLoading={confirm.isPending}>
              Confirmer l'activation
            </Button>
          </div>
        )}
      </Container>
    </PageContainer>
  )
}
