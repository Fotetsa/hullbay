import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { role?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Hullbay — accès mis à jour (${ctx.role ?? "rôle"})`,
    en: `Hullbay — access updated (${ctx.role ?? "role"})`,
  })
}

export function Component(props: { email?: string; role?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Mise à jour de votre accès",
      hello: "Bonjour,",
      message: "Votre accès à Hullbay a été mis à jour.",
      email: "Email :",
      role: "Nouveau rôle :",
      updated: "Les permissions associées à votre compte ont été ajustées.",
      contact: "Si cette modification ne vous semble pas correcte, veuillez contacter un owner.",
    },
    en: {
      title: "Your access has been updated",
      hello: "Hello,",
      message: "Your access to Hullbay has been updated.",
      email: "Email:",
      role: "New role:",
      updated: "The permissions associated with your account have been adjusted.",
      contact: "If this change looks incorrect, please contact an owner.",
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
            <p style={{ margin: 0 }}><strong>{t.email}</strong> {props.email ?? "-"}</p>
            <p style={{ margin: "8px 0 0" }}><strong>{t.role}</strong> {props.role ?? "-"}</p>
          </div>
          <p>{t.updated}</p>
          <p>{t.contact}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
