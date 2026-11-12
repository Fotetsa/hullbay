import * as React from "react"
import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"

interface LayoutProps {
  previewText: string
  title: string
  subtitle?: string
  children: React.ReactNode | any
}

/**
 * Layout commun pour tous les courriels transactionnels de Hullbay.
 *
 * Utilise React Email pour un rendu responsive compatible avec tous les clients
 * de messagerie (Gmail, Outlook, Apple Mail). Les couleurs et la typographie
 * respectent la charte sombre / technique d'Hullbay (Ops-Panel).
 */
export function Layout({ previewText, title, subtitle, children }: LayoutProps) {
  return (
    <Html lang="fr">
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={mainStyle}>
        <Container style={containerStyle}>
          {/* En-tête avec marque Hullbay */}
          <Section style={headerSection}>
            <div style={brandBadge}>
              <span style={brandDot} />
              <span style={brandText}>HULLBAY OPS</span>
            </div>
            <Heading style={headingStyle}>{title}</Heading>
            {subtitle && <Text style={subtitleStyle}>{subtitle}</Text>}
          </Section>

          <Hr style={hrStyle} />

          {/* Corps de l'e-mail */}
          <Section style={contentSection}>{children as any}</Section>

          <Hr style={hrStyle} />

          {/* Pied de page de sécurité */}
          <Section style={footerSection}>
            <Text style={footerText}>
              Cet e-mail est généré automatiquement par votre plateforme <strong>Hullbay</strong>.
              Ne répondez pas directement à ce message sauf si une adresse de réponse dédiée est indiquée.
            </Text>
            <Text style={footerSubtext}>
              Orchestration sécurisée Docker & Swarm • Multi-VPS Visual Control Plane
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

// ── Styles inline (requis pour compatibilité clients e-mail) ──

const mainStyle: React.CSSProperties = {
  backgroundColor: "#09090b",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif',
  margin: "0 auto",
  padding: "40px 10px",
  color: "#f4f4f5",
}

const containerStyle: React.CSSProperties = {
  backgroundColor: "#18181b",
  border: "1px solid #27272a",
  borderRadius: "8px",
  maxWidth: "580px",
  margin: "0 auto",
  padding: "32px",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.4)",
}

const headerSection: React.CSSProperties = {
  marginBottom: "16px",
}

const brandBadge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  backgroundColor: "#27272a",
  padding: "4px 10px",
  borderRadius: "9999px",
  marginBottom: "16px",
}

const brandDot: React.CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  backgroundColor: "#3b82f6",
  display: "inline-block",
}

const brandText: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "#93c5fd",
  textTransform: "uppercase",
}

const headingStyle: React.CSSProperties = {
  color: "#fafafa",
  fontSize: "22px",
  fontWeight: 700,
  lineHeight: "1.3",
  margin: "0 0 6px 0",
}

const subtitleStyle: React.CSSProperties = {
  color: "#a1a1aa",
  fontSize: "14px",
  lineHeight: "1.5",
  margin: "0",
}

const contentSection: React.CSSProperties = {
  padding: "16px 0",
}

const hrStyle: React.CSSProperties = {
  borderColor: "#27272a",
  margin: "20px 0",
}

const footerSection: React.CSSProperties = {
  textAlign: "center" as const,
  paddingTop: "8px",
}

const footerText: React.CSSProperties = {
  color: "#71717a",
  fontSize: "12px",
  lineHeight: "1.5",
  margin: "0 0 8px 0",
}

const footerSubtext: React.CSSProperties = {
  color: "#52525b",
  fontSize: "11px",
  margin: "0",
}
