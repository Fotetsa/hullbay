import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: "Hullbay — accès supprimé",
    en: "Hullbay — access removed",
  })
}

export function Component(props: { email?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Accès supprimé",
      hello: "Bonjour,",
      message: "Votre accès à Hullbay a été supprimé.",
      label: "Email concerné :",
      note: "Cette action a été effectuée par un owner ou un administrateur.",
      contact: "Si vous pensez qu’il s’agit d’une erreur, veuillez contacter immédiatement l’owner.",
    },
    en: {
      title: "Access removed",
      hello: "Hello,",
      message: "Your access to Hullbay has been removed.",
      label: "Affected email:",
      note: "This action was performed by an owner or administrator.",
      contact: "If you believe this is a mistake, please contact an owner immediately.",
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
            <p style={{ margin: 0 }}><strong>{t.label}</strong> {props.email ?? "-"}</p>
          </div>
          <p>{t.note}</p>
          <p>{t.contact}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
