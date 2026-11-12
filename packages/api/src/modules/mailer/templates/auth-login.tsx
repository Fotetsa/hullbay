import * as React from "react"
import { Button, Section, Text } from "@react-email/components"
import { Layout } from "./components/Layout"

export interface AuthLoginEmailProps {
  userName: string
  userEmail: string
  loginTime: string
  ipAddress: string
  userAgent: string
  location?: string
  authMethod: string // "Mot de passe", "WebAuthn / Passkey", "SAML SSO", "LDAP"
  securitySettingsUrl?: string
}

/**
 * Notification de connexion au compte Hullbay.
 *
 * Permet à l'utilisateur de vérifier l'activité sur son compte et de réagir
 * rapidement en cas d'accès non autorisé.
 */
export default function AuthLoginEmail({
  userName,
  userEmail,
  loginTime,
  ipAddress,
  userAgent,
  location = "Emplacement non géolocalisé",
  authMethod,
  securitySettingsUrl,
}: AuthLoginEmailProps) {
  return (
    <Layout
      previewText={`Nouvelle connexion détectée sur votre compte Hullbay (${userEmail})`}
      title="Nouvelle connexion détectée"
      subtitle={`Bonjour ${userName}, un accès vient d'être enregistré sur votre compte.`}
    >
      <Section style={{ marginBottom: "20px" }}>
        <Text style={{ fontSize: "14px", color: "#d4d4d8", margin: "0 0 16px 0", lineHeight: "1.5" }}>
          Si vous êtes bien à l'origine de cette connexion, vous pouvez ignorer cet e-mail. Dans le
          cas contraire, nous vous recommandons de réinitialiser immédiatement votre mot de passe et
          de révoquer les sessions actives.
        </Text>

        <div style={detailsBox}>
          <div style={detailRow}>
            <span style={detailLabel}>Date & Heure :</span>
            <span style={detailValue}>{loginTime}</span>
          </div>
          <div style={detailRow}>
            <span style={detailLabel}>Méthode :</span>
            <span style={detailValue}>{authMethod}</span>
          </div>
          <div style={detailRow}>
            <span style={detailLabel}>Adresse IP :</span>
            <span style={detailValue}>{ipAddress}</span>
          </div>
          <div style={detailRow}>
            <span style={detailLabel}>Navigateur :</span>
            <span style={detailValue}>{userAgent}</span>
          </div>
          {location && (
            <div style={detailRow}>
              <span style={detailLabel}>Localisation :</span>
              <span style={detailValue}>{location}</span>
            </div>
          )}
        </div>
      </Section>

      {securitySettingsUrl && (
        <Section style={{ textAlign: "center", marginTop: "24px" }}>
          <Button href={securitySettingsUrl} style={securityButton}>
            Vérifier mes paramètres de sécurité
          </Button>
        </Section>
      )}
    </Layout>
  )
}

// ── Dummy Data de prévisualisation ──

export const previewProps: AuthLoginEmailProps = {
  userName: "Alexandre Leroy",
  userEmail: "alexandre.leroy@hullbay.io",
  loginTime: "29 Octobre 2026 à 03:22:10 UTC",
  ipAddress: "194.214.120.35",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0",
  location: "Paris, France",
  authMethod: "Passkey (WebAuthn FIDO2)",
  securitySettingsUrl: "https://ops.hullbay.local/settings",
}

const detailsBox: React.CSSProperties = {
  backgroundColor: "#27272a",
  border: "1px solid #3f3f46",
  borderRadius: "6px",
  padding: "16px",
}

const detailRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  padding: "6px 0",
  borderBottom: "1px solid #333338",
  fontSize: "13px",
}

const detailLabel: React.CSSProperties = {
  color: "#a1a1aa",
  fontWeight: 500,
}

const detailValue: React.CSSProperties = {
  color: "#fafafa",
  fontWeight: 600,
}

const securityButton: React.CSSProperties = {
  backgroundColor: "#dc2626",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 600,
  padding: "10px 20px",
  borderRadius: "6px",
  textDecoration: "none",
  display: "inline-block",
}
