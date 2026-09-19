import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { email?: string; role?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Hullbay — compte créé (${ctx.role ?? "utilisateur"})`,
    en: `Hullbay — account created (${ctx.role ?? "user"})`,
  })
}

export function Component(props: { email?: string; role?: string; actorUserId?: string; targetUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Bienvenue sur Hullbay",
      hello: "Bonjour,",
      message: "Votre compte a bien été créé sur Hullbay.",
      email: "Email :",
      role: "Rôle :",
      access: "Vous pouvez maintenant vous connecter et accéder à votre espace.",
      alert: "Si vous n’êtes pas à l’origine de cette création, merci de contacter immédiatement un owner.",
    },
    en: {
      title: "Welcome to Hullbay",
      hello: "Hello,",
      message: "Your account has been created on Hullbay.",
      email: "Email:",
      role: "Role:",
      access: "You can now sign in and access your workspace.",
      alert: "If you did not initiate this creation, please contact an owner immediately.",
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
          <p>{t.access}</p>
          <p>{t.alert}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
