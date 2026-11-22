import * as React from "react"
import { Section, Text } from "@react-email/components"
import { Layout } from "./components/Layout"

export interface MailTestEmailProps {
  provider: "RESEND" | "SMTP"
  testedBy: string
  sentAt: string
  fromAddress: string
  replyTo?: string
  tenantName?: string
}

/**
 * Template envoyé lors du clic sur le bouton "Tester la configuration" dans
 * la page Paramètres (Settings).
 */
export default function MailTestEmail({
  provider,
  testedBy,
  sentAt,
  fromAddress,
  replyTo,
  tenantName = "Organisation principale",
}: MailTestEmailProps) {
  return (
    <Layout
      previewText="Test de connectivité réussi pour votre serveur d'e-mails Hullbay"
      title="Test d'intégration E-mail"
      subtitle="Félicitations ! Vos paramètres d'expédition sont parfaitement opérationnels."
    >
      <Section style={{ marginBottom: "20px" }}>
        <Text style={{ fontSize: "14px", color: "#d4d4d8", margin: "0 0 16px 0", lineHeight: "1.5" }}>
          Ce message confirme que votre fournisseur d'e-mails (<strong>{provider}</strong>) est correctement
          configuré dans Hullbay Ops et que l'authentification a abouti.
        </Text>

        <div style={detailsBox}>
          <div style={detailRow}>
            <span style={detailLabel}>Fournisseur actif :</span>
            <span style={{ ...detailValue, color: "#38bdf8" }}>{provider}</span>
          </div>
          <div style={detailRow}>
            <span style={detailLabel}>Organisation :</span>
            <span style={detailValue}>{tenantName}</span>
          </div>
          <div style={detailRow}>
            <span style={detailLabel}>Expéditeur utilisé :</span>
            <span style={detailValue}>{fromAddress}</span>
          </div>
          {replyTo && (
            <div style={detailRow}>
              <span style={detailLabel}>Adresse Reply-To :</span>
              <span style={detailValue}>{replyTo}</span>
            </div>
          )}
          <div style={detailRow}>
            <span style={detailLabel}>Déclenché par :</span>
            <span style={detailValue}>{testedBy}</span>
          </div>
          <div style={detailRow}>
            <span style={detailLabel}>Date du test :</span>
            <span style={detailValue}>{sentAt}</span>
          </div>
        </div>
      </Section>
    </Layout>
  )
}

// ── Dummy Data de prévisualisation ──

export const previewProps: MailTestEmailProps = {
  provider: "RESEND",
  testedBy: "admin@hullbay.io",
  sentAt: "29 Octobre 2026 à 03:28:15 UTC",
  fromAddress: "Hullbay Notifications <notifications@hullbay.io>",
  replyTo: "support@hullbay.io",
  tenantName: "Cluster Principal (Default Tenant)",
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
