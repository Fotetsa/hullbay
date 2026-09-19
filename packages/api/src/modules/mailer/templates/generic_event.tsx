import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { event?: string; message?: string; name?: string; ok?: boolean; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  const prefix = ctx.event ?? getMailText(locale, { fr: "Événement", en: "Event" })
  return `${prefix} — ${getMailText(locale, { fr: "notification", en: "notification" })}`
}

export function Component(props: { event?: string; message?: string; name?: string; ok?: boolean; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const event = props.event ?? getMailText(locale, { fr: "événement", en: "event" })
  const message = props.message ?? getMailText(locale, { fr: "Une action système a été déclenchée.", en: "A system action was triggered." })
  const t = getMailText(locale, {
    fr: { title: "Notification Hullbay", event: "Événement :", status: "Statut :", success: "Succès", failed: "Échec", user: "Utilisateur :" },
    en: { title: "Hullbay notification", event: "Event:", status: "Status:", success: "Success", failed: "Failed", user: "User:" },
  })
  return (
    <html>
      <body>
        <div>
          <h1>{t.title}</h1>
          <p><strong>{t.event}</strong> {event}</p>
          <p>{message}</p>
          {typeof props.ok === "boolean" && <p>{t.status} {props.ok ? t.success : t.failed}</p>}
          {props.name && <p>{t.user} {props.name}</p>}
        </div>
      </body>
    </html>
  )
}

export function Text(ctx: { event?: string; message?: string; name?: string; ok?: boolean; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  const event = ctx.event ?? getMailText(locale, { fr: "événement", en: "event" })
  const message = ctx.message ?? getMailText(locale, { fr: "Une action système a été déclenchée.", en: "A system action was triggered." })
  const t = getMailText(locale, { fr: { success: "Succès", failed: "Échec", user: "Utilisateur" }, en: { success: "Success", failed: "Failed", user: "User" } })
  return `${event}: ${message}${typeof ctx.ok === "boolean" ? ` | Status: ${ctx.ok ? t.success : t.failed}` : ""}${ctx.name ? ` | ${t.user}: ${ctx.name}` : ""}`
}

export const meta = { requires: [] }
