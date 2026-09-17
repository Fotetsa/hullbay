import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { ok?: boolean; projectName?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `${ctx.projectName ?? "Projet"} — ${ctx.ok ? "Déploiement réussi" : "Échec du déploiement"}`,
    en: `${ctx.projectName ?? "Project"} — ${ctx.ok ? "Deployment successful" : "Deployment failed"}`,
  })
}

export function Component(props: { ok?: boolean; projectName?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: { title: "État du déploiement", project: "Projet :", status: "Statut :", success: "Succès", failed: "Échec" },
    en: { title: "Deployment status", project: "Project:", status: "Status:", success: "Success", failed: "Failed" },
  })

  return (
    <html>
      <body>
        <div>
          <h1>{t.title}</h1>
          <p>{t.project} {props.projectName ?? "-"}</p>
          <p>{t.status} {props.ok ? t.success : t.failed}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: ["project.name"] }
