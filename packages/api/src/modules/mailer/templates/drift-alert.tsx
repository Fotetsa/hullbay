import * as React from "react"
import { Button, Section, Text } from "@react-email/components"
import { Layout } from "./components/Layout"

export interface DriftAlertEmailProps {
  clusterName: string
  projectName?: string
  detectedAt: string
  diffCount: number
  diffs: Array<{
    target: string
    reason: string
    severity: "low" | "medium" | "high"
  }>
  reconcileUrl?: string
}

/**
 * Alerte envoyée aux opérateurs lorsqu'une dérive entre la topologie déclarée
 * dans Hullbay et l'état réel des conteneurs/services Swarm est constatée.
 */
export default function DriftAlertEmail({
  clusterName,
  projectName = "Infrastructure globale",
  detectedAt,
  diffCount,
  diffs = [],
  reconcileUrl,
}: DriftAlertEmailProps) {
  return (
    <Layout
      previewText={`⚠️ Alerte Dérive détectée sur ${clusterName} (${diffCount} écarts)`}
      title="Dérive d'infrastructure détectée"
      subtitle={`Écart constaté entre le Canvas Hullbay et l'état effectif de ${clusterName}`}
    >
      <Section style={{ marginBottom: "20px" }}>
        <Text style={{ fontSize: "14px", color: "#d4d4d8", margin: "0 0 16px 0", lineHeight: "1.5" }}>
          Le job d'observation d'infrastructure a détecté des divergences non souhaitées sur{" "}
          <strong>{projectName}</strong>. Les ressources listées ci-dessous ont été modifiées ou arrêtées
          en dehors du cycle de déploiement de l'Ops-Panel :
        </Text>

        <div style={diffsList}>
          {diffs.map((diff, index) => {
            const badgeColor =
              diff.severity === "high"
                ? "#ef4444"
                : diff.severity === "medium"
                  ? "#f59e0b"
                  : "#3b82f6"
            return (
              <div key={index} style={diffItem}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                  <span style={diffTarget}>{diff.target}</span>
                  <span
                    style={{
                      fontSize: "10px",
                      textTransform: "uppercase",
                      fontWeight: 700,
                      color: badgeColor,
                    }}
                  >
                    {diff.severity}
                  </span>
                </div>
                <Text style={diffReason}>{diff.reason}</Text>
              </div>
            )
          })}
        </div>
      </Section>

      {reconcileUrl && (
        <Section style={{ textAlign: "center", marginTop: "24px" }}>
          <Button href={reconcileUrl} style={reconcileButton}>
            Examiner et Réconcilier le Cluster
          </Button>
        </Section>
      )}
    </Layout>
  )
}

// ── Dummy Data de prévisualisation ──

export const previewProps: DriftAlertEmailProps = {
  clusterName: "Swarm Production DC1",
  projectName: "Stack Commerce & Checkout",
  detectedAt: "29 Octobre 2026 à 03:29:40 UTC",
  diffCount: 3,
  diffs: [
    {
      target: "service: postgres-db-primary",
      reason: "Le conteneur a crashé (ExitCode 137 OOMKilled) sur le nœud worker-3.",
      severity: "high",
    },
    {
      target: "container: orphaned-temp-worker",
      reason: "Conteneur non rattaché au canvas Hullbay détecté sur le nœud manager-1.",
      severity: "medium",
    },
    {
      target: "network: boz_checkout_overlay",
      reason: "Un driver réseau non conforme a été appliqué hors de Hullbay.",
      severity: "low",
    },
  ],
  reconcileUrl: "https://ops.hullbay.local/health",
}

const diffsList: React.CSSProperties = {
  backgroundColor: "#18181b",
  border: "1px solid #27272a",
  borderRadius: "6px",
  padding: "8px",
}

const diffItem: React.CSSProperties = {
  backgroundColor: "#27272a",
  borderRadius: "4px",
  padding: "10px",
  marginBottom: "8px",
  border: "1px solid #3f3f46",
}

const diffTarget: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  color: "#fafafa",
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
}

const diffReason: React.CSSProperties = {
  fontSize: "12px",
  color: "#d4d4d8",
  margin: "0",
  lineHeight: "1.4",
}

const reconcileButton: React.CSSProperties = {
  backgroundColor: "#ea580c",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 600,
  padding: "10px 20px",
  borderRadius: "6px",
  textDecoration: "none",
  display: "inline-block",
}
