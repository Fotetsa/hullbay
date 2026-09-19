import React from "react"
import { getMailText } from "../i18n"

export async function Subject(ctx: { name?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: "Mail asynchrone",
    en: "Async mail",
  })
}

export function Component(props: { name?: string; locale?: string }) {
  const locale = (props.locale ?? "en") as "fr" | "en"
  const t = getMailText(locale, {
    fr: { title: "Mail asynchrone", hello: "Bonjour", user: "ami" },
    en: { title: "Async mail", hello: "Hello", user: "friend" },
  })

  return (
    <html>
      <body>
        <div>
          <h1>{t.title}</h1>
          <p>{t.hello} {props.name ?? t.user}</p>
        </div>
      </body>
    </html>
  )
}

export async function Text(ctx: { name?: string; locale?: string }) {
  const locale = (ctx.locale ?? "en") as "fr" | "en"
  return getMailText(locale, {
    fr: `Bonjour ${ctx.name ?? "ami"}`,
    en: `Hello ${ctx.name ?? "friend"}`,
  })
}

export const meta = { requires: [] }
