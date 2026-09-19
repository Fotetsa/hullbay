import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { serverId?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Hullbay — serveur provisionné (${ctx.serverId ?? "N/A"})`,
    en: `Hullbay — server provisioned (${ctx.serverId ?? "N/A"})`,
  })
}

export function Component(props: { serverId?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Serveur provisionné",
      hello: "Bonjour,",
      message: "Le serveur a bien été provisionné dans Hullbay.",
      label: "Serveur :",
      note: "Il est maintenant prêt à être géré depuis votre interface.",
    },
    en: {
      title: "Server provisioned",
      hello: "Hello,",
      message: "The server has been provisioned in Hullbay.",
      label: "Server:",
      note: "It is now ready to be managed from your interface.",
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
            <p style={{ margin: 0 }}><strong>{t.label}</strong> {props.serverId ?? "-"}</p>
          </div>
          <p>{t.note}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
