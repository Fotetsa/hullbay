import React from "react"
import { getMailText } from "../i18n"

export function Subject(ctx: { name?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Hullbay — secret mis à jour (${ctx.name ?? "secret"})`,
    en: `Hullbay — secret updated (${ctx.name ?? "secret"})`,
  })
}

export function Component(props: { name?: string; clusterId?: string; actorUserId?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: {
      title: "Secret mis à jour",
      hello: "Bonjour,",
      message: "Un secret a été ajouté ou modifié.",
      name: "Nom :",
      cluster: "Cluster :",
      note: "Cette modification peut affecter les accès ou intégrations associées.",
    },
    en: {
      title: "Secret updated",
      hello: "Hello,",
      message: "A secret has been added or modified.",
      name: "Name:",
      cluster: "Cluster:",
      note: "This change may affect related access or integrations.",
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
            <p style={{ margin: 0 }}><strong>{t.name}</strong> {props.name ?? "-"}</p>
            <p style={{ margin: "8px 0 0" }}><strong>{t.cluster}</strong> {props.clusterId ?? "-"}</p>
          </div>
          <p>{t.note}</p>
        </div>
      </body>
    </html>
  )
}

export const meta = { requires: [] }
