import * as React from "react"
import { Button, Section, Text } from "@react-email/components"
import { Layout } from "./components/Layout"

export interface DeployFinishedEmailProps {
  projectName: string
  projectSlug: string
  clusterName?: string
  ok: boolean
  executedBy?: string
  timestamp: string
  durationSec?: number
  log?: string[]
  error?: string
  dashboardUrl?: string
  servicesSummary?: {
    created?: number
    updated?: number
    removed?: number
    total?: number
  }
}

/**
 * Template de notification pour la fin d'un déploiement Swarm / Docker.
 *
 * Fournit un rapport détaillé avec statut visuel, métriques clés, étapes du workflow
 * ou rapport d'erreur formaté façon console si le déploiement a échoué.
 */
export default function DeployFinishedEmail({
  projectName,
  projectSlug,
  clusterName = "Cluster principal",
  ok,
  executedBy = "Opérateur inconnu",
  timestamp,
  durationSec,
  log = [],
  error,
  dashboardUrl,
  servicesSummary,
}: DeployFinishedEmailProps) {
  const statusColor = ok ? "#22c55e" : "#ef4444"
  const statusBg = ok ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)"
  const statusText = ok ? "DÉPLOIEMENT RÉUSSI" : "DÉPLOIEMENT ÉCHOUÉ"

  return (
    <Layout
      previewText={`${ok ? "✅ Succès" : "❌ Échec"} Déploiement : ${projectName} (${projectSlug})`}
      title={`Projet : ${projectName}`}
      subtitle={`Rapport d'exécution de la topologie sur ${clusterName}`}
    >
      {/* Badge statut bien visible */}
      <div
        style={{
          backgroundColor: statusBg,
          border: `1px solid ${statusColor}`,
          borderRadius: "6px",
          padding: "12px 16px",
          marginBottom: "20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <span
            style={{
              color: statusColor,
              fontWeight: 700,
              fontSize: "14px",
              letterSpacing: "0.05em",
            }}
          >
            {statusText}
          </span>
          <Text style={{ margin: "4px 0 0 0", fontSize: "12px", color: "#a1a1aa" }}>
            Déclenché par {executedBy} • {timestamp}
          </Text>
        </div>
        {durationSec !== undefined && (
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "12px", color: "#a1a1aa" }}>Durée</span>
            <Text style={{ margin: "0", fontSize: "13px", fontWeight: 600, color: "#f4f4f5" }}>
              {durationSec}s
            </Text>
          </div>
        )}
      </div>

      {/* Résumé des services si présent */}
      {servicesSummary && (
        <Section style={statsGrid}>
          <div style={statBox}>
            <span style={statNumber}>{servicesSummary.total ?? 0}</span>
            <span style={statLabel}>Total Services</span>
          </div>
          <div style={statBox}>
            <span style={{ ...statNumber, color: "#22c55e" }}>+{servicesSummary.created ?? 0}</span>
            <span style={statLabel}>Créés</span>
          </div>
          <div style={statBox}>
            <span style={{ ...statNumber, color: "#3b82f6" }}>~{servicesSummary.updated ?? 0}</span>
            <span style={statLabel}>Mis à jour</span>
          </div>
          <div style={statBox}>
            <span style={{ ...statNumber, color: "#ef4444" }}>-{servicesSummary.removed ?? 0}</span>
            <span style={statLabel}>Supprimés</span>
          </div>
        </Section>
      )}

      {/* Bloc d'erreur détaillée en cas d'échec */}
      {!ok && error && (
        <Section style={{ marginBottom: "20px" }}>
          <Text style={sectionTitle}>Détail de l'incident :</Text>
          <div style={errorContainer}>
            <code style={errorCode}>{error}</code>
          </div>
        </Section>
      )}

      {/* Extrait des journaux du déploiement */}
      {log && log.length > 0 && (
        <Section style={{ marginBottom: "20px" }}>
          <Text style={sectionTitle}>Dernières étapes du déploiement :</Text>
          <div style={logContainer}>
            {log.slice(-8).map((step, idx) => (
              <div key={idx} style={logLine}>
                <span style={logArrow}>›</span> {step}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Bouton d'action vers le Canvas */}
      {dashboardUrl && (
        <Section style={{ textAlign: "center", marginTop: "24px" }}>
          <Button href={dashboardUrl} style={actionButton}>
            Ouvrir le Canvas dans Hullbay
          </Button>
        </Section>
      )}
    </Layout>
  )
}

// ── Dummy Data pour la prévisualisation (succès et échec) ──

export const previewPropsSuccess: DeployFinishedEmailProps = {
  projectName: "API Production & Cache",
  projectSlug: "api-prod-cache",
  clusterName: "Swarm Production DC1 (3 Managers, 5 Workers)",
  ok: true,
  executedBy: "alexandre.leroy@hullbay.io",
  timestamp: "29 Octobre 2026 à 03:15:22 UTC",
  durationSec: 14.2,
  servicesSummary: {
    total: 6,
    created: 2,
    updated: 4,
    removed: 0,
  },
  log: [
    "[1/6] Validation du graphe déclaratif et des dépendances réseau overlay",
    "[2/6] Vérification des secrets chiffrés et des volumes persistants",
    "[3/6] Réseau overlay 'boz_api-prod-cache_net' provisionné",
    "[4/6] Service 'redis-cache' mis à jour vers redis:7-alpine",
    "[5/6] Service 'api-core' redéployé avec 3 réplicas (rolling update)",
    "[6/6] Configuration du reverse-proxy Caddy rechargée sans coupure",
  ],
  dashboardUrl: "https://ops.hullbay.local/projects/api-prod-cache",
}

export const previewPropsFailed: DeployFinishedEmailProps = {
  projectName: "Base de Données Analytics",
  projectSlug: "analytics-db",
  clusterName: "Swarm Production DC1",
  ok: false,
  executedBy: "marie.curie@hullbay.io",
  timestamp: "29 Octobre 2026 à 03:18:05 UTC",
  durationSec: 8.5,
  error:
    "DeployError: Le service 'postgres-analytics' n'a pas pu démarrer sur les nœuds workers : image ghcr.io/hullbay/analytics-pg:v2.4 introuvable (404 Unauthorized). Vérifiez les identifiants du registre dans les paramètres d'intégrations.",
  servicesSummary: {
    total: 3,
    created: 1,
    updated: 0,
    removed: 0,
  },
  log: [
    "[1/4] Validation du graphe déclaratif : OK",
    "[2/4] Création du volume persistant 'pgdata_analytics' : OK",
    "[3/4] Pull de l'image ghcr.io/hullbay/analytics-pg:v2.4...",
    "[ÉCHEC] Erreur d'authentification registry ou image inexistante sur le nœud worker-2",
  ],
  dashboardUrl: "https://ops.hullbay.local/projects/analytics-db",
}

export const previewProps = previewPropsSuccess

// ── Styles ──

const statsGrid: React.CSSProperties = {
  display: "flex",
  gap: "8px",
  marginBottom: "20px",
}

const statBox: React.CSSProperties = {
  flex: 1,
  backgroundColor: "#27272a",
  borderRadius: "6px",
  padding: "10px",
  textAlign: "center",
  border: "1px solid #3f3f46",
}

const statNumber: React.CSSProperties = {
  fontSize: "16px",
  fontWeight: 700,
  color: "#fafafa",
  display: "block",
}

const statLabel: React.CSSProperties = {
  fontSize: "10px",
  color: "#a1a1aa",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginTop: "2px",
  display: "block",
}

const sectionTitle: React.CSSProperties = {
  fontSize: "12px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#a1a1aa",
  margin: "0 0 8px 0",
}

const errorContainer: React.CSSProperties = {
  backgroundColor: "rgba(239, 68, 68, 0.08)",
  border: "1px solid rgba(239, 68, 68, 0.3)",
  borderRadius: "6px",
  padding: "12px",
}

const errorCode: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: "12px",
  color: "#fca5a5",
  lineHeight: "1.5",
  display: "block",
  whiteSpace: "pre-wrap",
}

const logContainer: React.CSSProperties = {
  backgroundColor: "#09090b",
  border: "1px solid #27272a",
  borderRadius: "6px",
  padding: "12px",
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: "11px",
  color: "#d4d4d8",
  lineHeight: "1.6",
}

const logLine: React.CSSProperties = {
  marginBottom: "3px",
}

const logArrow: React.CSSProperties = {
  color: "#3b82f6",
  fontWeight: 700,
  marginRight: "4px",
}

const actionButton: React.CSSProperties = {
  backgroundColor: "#2563eb",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 600,
  padding: "10px 20px",
  borderRadius: "6px",
  textDecoration: "none",
  display: "inline-block",
}
