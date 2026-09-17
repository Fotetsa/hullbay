import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { serverId?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Hullbay — serveur supprimé (${ctx.serverId ?? "N/A"})`,
    en: `Hullbay — server removed (${ctx.serverId ?? "N/A"})`,
  })
}

export function Component(props: { serverId?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Serveur supprimé",
      hello: "Bonjour,",
      message: "Le serveur a été supprimé de Hullbay.",
      label: "Serveur :",
      note: "Cette action est définitive et peut affecter les accès ou services associés.",
    },
    en: {
      title: "Server removed",
      hello: "Hello,",
      message: "The server has been removed from Hullbay.",
      label: "Server:",
      note: "This action is permanent and may affect related access or services.",
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
