import * as React from "react"
import { render } from "@react-email/render"
import DeployFinishedEmail, {
  previewPropsSuccess,
  previewPropsFailed,
  type DeployFinishedEmailProps,
} from "./deploy-finished"
import AuthLoginEmail, {
  previewProps as authLoginPreviewProps,
  type AuthLoginEmailProps,
} from "./auth-login"
import PasswordChangedEmail, {
  previewProps as passwordChangedPreviewProps,
  type PasswordChangedEmailProps,
} from "./password-changed"
import MailTestEmail, {
  previewProps as mailTestPreviewProps,
  type MailTestEmailProps,
} from "./mail-test"
import DriftAlertEmail, {
  previewProps as driftAlertPreviewProps,
  type DriftAlertEmailProps,
} from "./drift-alert"

/**
 * Registre centralisé des templates React Email de Hullbay.
 *
 * Fournit pour chaque template :
 * - Ses métadonnées descriptives (id, nom, description, sujet par défaut)
 * - Son jeu de données fictives (dummy data / preview props)
 * - La méthode de compilation vers HTML et texte brut via @react-email/render
 */
export interface TemplateDefinition<T = any> {
  id: string
  name: string
  description: string
  defaultSubject: (props: T) => string
  previewProps: T
  additionalPreviews?: Record<string, T>
  renderHtml: (props: T) => Promise<string>
  renderText: (props: T) => Promise<string>
}

export const TEMPLATES: Record<string, TemplateDefinition> = {
  "deploy.finished": {
    id: "deploy.finished",
    name: "Rapport de Déploiement (Succès / Échec)",
    description: "Notification détaillée à l'issue de l'application d'une topologie sur Swarm",
    defaultSubject: (props: DeployFinishedEmailProps) =>
      `${props.ok ? "✅ Déploiement réussi" : "❌ Échec de déploiement"} : ${props.projectName}`,
    previewProps: previewPropsSuccess,
    additionalPreviews: {
      "Succès (déploiement normal)": previewPropsSuccess,
      "Échec (erreur d'image ou tunnel)": previewPropsFailed,
    },
    renderHtml: async (props: DeployFinishedEmailProps) => {
      return render(React.createElement(DeployFinishedEmail, props))
    },
    renderText: async (props: DeployFinishedEmailProps) => {
      return render(React.createElement(DeployFinishedEmail, props), { plainText: true })
    },
  },

  "auth.login": {
    id: "auth.login",
    name: "Alerte de Connexion",
    description: "Alerte de sécurité envoyée lors d'une nouvelle session sur le compte",
    defaultSubject: () => "Nouvelle connexion détectée sur votre compte Hullbay",
    previewProps: authLoginPreviewProps,
    renderHtml: async (props: AuthLoginEmailProps) => {
      return render(React.createElement(AuthLoginEmail, props))
    },
    renderText: async (props: AuthLoginEmailProps) => {
      return render(React.createElement(AuthLoginEmail, props), { plainText: true })
    },
  },

  "password.changed": {
    id: "password.changed",
    name: "Modification du Mot de Passe",
    description: "Confirmation de mise à jour des identifiants",
    defaultSubject: () => "Votre mot de passe Hullbay a été modifié",
    previewProps: passwordChangedPreviewProps,
    renderHtml: async (props: PasswordChangedEmailProps) => {
      return render(React.createElement(PasswordChangedEmail, props))
    },
    renderText: async (props: PasswordChangedEmailProps) => {
      return render(React.createElement(PasswordChangedEmail, props), { plainText: true })
    },
  },

  "mail.test": {
    id: "mail.test",
    name: "Test de Configuration Mail",
    description: "E-mail de vérification émis depuis la section Paramètres",
    defaultSubject: (props: MailTestEmailProps) =>
      `[Hullbay] Test d'envoi réussi via ${props.provider}`,
    previewProps: mailTestPreviewProps,
    renderHtml: async (props: MailTestEmailProps) => {
      return render(React.createElement(MailTestEmail, props))
    },
    renderText: async (props: MailTestEmailProps) => {
      return render(React.createElement(MailTestEmail, props), { plainText: true })
    },
  },

  "drift.alert": {
    id: "drift.alert",
    name: "Alerte Dérive d'Infrastructure",
    description: "Notification émise en cas de désynchronisation entre le Canvas et Docker Swarm",
    defaultSubject: (props: DriftAlertEmailProps) =>
      `⚠️ Dérive détectée sur le cluster ${props.clusterName}`,
    previewProps: driftAlertPreviewProps,
    renderHtml: async (props: DriftAlertEmailProps) => {
      return render(React.createElement(DriftAlertEmail, props))
    },
    renderText: async (props: DriftAlertEmailProps) => {
      return render(React.createElement(DriftAlertEmail, props), { plainText: true })
    },
  },
}

export function getTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATES[id]
}

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    previewVariants: t.additionalPreviews ? Object.keys(t.additionalPreviews) : ["default"],
  }))
}
