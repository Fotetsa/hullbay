import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { role?: string; serverId?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Hullbay — rôle du serveur modifié (${ctx.role ?? "rôle"})`,
    en: `Hullbay — server role changed (${ctx.role ?? "role"})`,
  })
}

export function Component(props: { serverId?: string; role?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Rôle du serveur modifié",
      hello: "Bonjour,",
      message: "Le rôle du serveur a été modifié.",
      server: "Serveur :",
      role: "Nouveau rôle :",
      note: "Cette modification peut avoir un impact sur les accès et permissions associées.",
    },
    en: {
      title: "Server role updated",
      hello: "Hello,",
      message: "The server role has been updated.",
      server: "Server:",
      role: "New role:",
      note: "This change may impact related access and permissions.",
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
            <p style={{ margin: 0 }}><strong>{t.server}</strong> {props.serverId ?? "-"}</p>
            <p style={{ margin: "8px 0 0" }}><strong>{t.role}</strong> {props.role ?? "-"}</p>
          </div>
          <p>{t.note}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
