import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: "Hullbay — registre mis à jour",
    en: "Hullbay — registry updated",
  })
}

export function Component(props: { registry?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Registre mis à jour",
      hello: "Bonjour,",
      message: "La configuration du registre a été mise à jour.",
      label: "Registre :",
      note: "Cette mise à jour peut affecter les prochains déploiements et accès associés.",
    },
    en: {
      title: "Registry updated",
      hello: "Hello,",
      message: "The registry configuration has been updated.",
      label: "Registry:",
      note: "This update may affect upcoming deployments and related access.",
    },
  })

  return (
    <html>
      <body style={{ fontFamily: "Arial, sans-serif", color: "#111827", lineHeight: 1.6 }}>
        <div style={{ maxWidth: 560, margin: "0 auto", padding: 24 }}>
          <h1 style={{ marginBottom: 12, fontSize: 28, color: "#111827" }}>{t.title}</h1>
          <p>{t.hello}</p>
          <p>{t.message}</p>
          <div style={{ background: "#f3f4f6", borderRadius: 8, padding: 16, margin: "16px 0" }}>
            <p style={{ margin: 0 }}><strong>{t.label}</strong> {props.registry ?? "-"}</p>
          </div>
          <p>{t.note}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
