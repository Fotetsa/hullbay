import * as React from "react"
import { Button, Section, Text } from "@react-email/components"
import { Layout } from "./components/Layout"

export interface PasswordChangedEmailProps {
  userName: string
  userEmail: string
  changedAt: string
  ipAddress?: string
  resetUrl?: string
}

/**
 * Notification de changement de mot de passe du compte utilisateur.
 */
export default function PasswordChangedEmail({
  userName,
  userEmail,
  changedAt,
  ipAddress = "Adresse IP non résolue",
  resetUrl,
}: PasswordChangedEmailProps) {
  return (
    <Layout
      previewText={`Confirmation de la modification du mot de passe de votre compte (${userEmail})`}
      title="Mot de passe modifié"
      subtitle={`Bonjour ${userName}, la mise à jour de vos identifiants a été enregistrée.`}
    >
      <Section style={{ marginBottom: "20px" }}>
        <Text style={{ fontSize: "14px", color: "#d4d4d8", margin: "0 0 16px 0", lineHeight: "1.5" }}>
          Le mot de passe associé à votre compte Hullbay a été modifié avec succès le{" "}
          <strong>{changedAt}</strong> (requête émise depuis {ipAddress}).
        </Text>

        <div style={warningBox}>
          <Text style={warningTitle}>⚠️ Vous n'êtes pas à l'origine de cette modification ?</Text>
          <Text style={warningText}>
            Si vous n'avez pas demandé ce changement, votre compte a peut-être été compromis.
            Réinitialisez immédiatement votre mot de passe et contactez votre administrateur de cluster.
          </Text>
        </div>
      </Section>

      {resetUrl && (
        <Section style={{ textAlign: "center", marginTop: "24px" }}>
          <Button href={resetUrl} style={resetButton}>
            Sécuriser mon compte
          </Button>
        </Section>
      )}
    </Layout>
  )
}

// ── Dummy Data de prévisualisation ──

export const previewProps: PasswordChangedEmailProps = {
  userName: "Alexandre Leroy",
  userEmail: "alexandre.leroy@hullbay.io",
  changedAt: "29 Octobre 2026 à 03:25:00 UTC",
  ipAddress: "194.214.120.35",
  resetUrl: "https://ops.hullbay.local/reset-password",
}

const warningBox: React.CSSProperties = {
  backgroundColor: "rgba(234, 179, 8, 0.1)",
  border: "1px solid rgba(234, 179, 8, 0.3)",
  borderRadius: "6px",
  padding: "14px",
}

const warningTitle: React.CSSProperties = {
  color: "#facc15",
  fontSize: "13px",
  fontWeight: 600,
  margin: "0 0 6px 0",
}

const warningText: React.CSSProperties = {
  color: "#e4e4e7",
  fontSize: "12px",
  lineHeight: "1.5",
  margin: "0",
}

const resetButton: React.CSSProperties = {
  backgroundColor: "#e11d48",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 600,
  padding: "10px 20px",
  borderRadius: "6px",
  textDecoration: "none",
  display: "inline-block",
}
