import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { siteName?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  const text = getMailText(locale, {
    fr: `${ctx.siteName ?? "Hullbay"} — Test d'email`,
    en: `${ctx.siteName ?? "Hullbay"} — Email test`,
  })
  return text
}

export function Component(props: { name?: string; message?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Test d'envoi",
      hello: "Bonjour",
      fallback: "Ceci est un email de test envoyé depuis Hullbay.",
      user: "utilisateur",
    },
    en: {
      title: "Test email",
      hello: "Hello",
      fallback: "This is a test email sent from Hullbay.",
      user: "user",
    },
  })

  return (
    <html>
      <body>
        <div>
          <h1>{t.title}</h1>
          <p>{t.hello} {props.name ?? t.user},</p>
          <p>{props.message ?? t.fallback}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
