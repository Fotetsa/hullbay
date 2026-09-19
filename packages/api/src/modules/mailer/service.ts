import { prisma } from "../../lib/prisma"
import { eventBus } from "../../lib/event-bus"
import { decryptSecret } from "../auth/crypto"
import { render } from "@react-email/render"
import React from "react"
import { sendViaResend } from "./providers/resend"
import { sendViaSmtp } from "./providers/smtp"

type SendOpts = { to?: string; from?: string; cc?: string[]; bcc?: string[]; projectId?: string }

const SENSITIVE_RE = /(secret|token|privateKey|password|pass|apiKey)/i

const EVENT_MAPPINGS: Record<string, { template: string; subject?: string }> = {
  "mail.test": { template: "mail_test" },
  "deploy.finished": { template: "deploy_finished", subject: ("Déploiement: {ok}") as unknown as string },
  "user.created": { template: "user_created" },
  "user.role.changed": { template: "user_role_changed" },
  "user.deleted": { template: "user_deleted" },
  "server.provisioned": { template: "server_provisioned" },
  "server.removed": { template: "server_removed" },
  "server.role.changed": { template: "server_role_changed" },
  "registry.set": { template: "registry_set" },
  "secret.set": { template: "secret_set" },
  "secret.removed": { template: "secret_removed" },
  "autoscale.applied": { template: "generic_event" },
  "drift.detected": { template: "generic_event" },
  "prune.finished": { template: "generic_event" },
  "update.done": { template: "generic_event" },
  "update.error": { template: "generic_event" },
  "cluster.status": { template: "generic_event" },
}

export class MailerService {
  constructor() {}

  private sanitize(d: Record<string, unknown>) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d)) {
      if (SENSITIVE_RE.test(k)) continue
      out[k] = v
    }
    return out
  }

  private async loadTemplate(templateName: string) {
    // dynamic import of template modules
    try {
      // template path relative to this file
      // e.g. ./templates/mail_test.tsx exports Component and Subject
      const mod = await import(`./templates/${templateName}`)
      return mod
    } catch (err) {
      try {
        const fallback = await import(`./templates/generic_event`)
        return fallback
      } catch {
        return null
      }
    }
  }

  private async renderTemplate(templateName: string, ctx: Record<string, unknown>) {
    const mod = await this.loadTemplate(templateName)
    if (!mod) throw new Error(`template ${templateName} not found`)
    const Component = mod.Component ?? mod.default
    const Subject = mod.Subject
    const element = React.createElement(Component, ctx)

    const normalizeString = async (value: unknown): Promise<string> => {
      if (value === null || value === undefined) return ""
      if (typeof value === "string") return value
      if (typeof value === "number" || typeof value === "boolean") return String(value)
      if (value instanceof Promise) return normalizeString(await value)
      if (React.isValidElement(value)) {
        const rendered = await render(value)
        return typeof rendered === "string" ? rendered : String(rendered)
      }
      if (typeof value === "object") {
        const asAny = value as any
        if (typeof asAny.html === "string") return asAny.html
        if (typeof asAny.toString === "function" && asAny.toString !== Object.prototype.toString) {
          return String(asAny)
        }
      }
      return String(value)
    }

    let html = ""
    try {
      const raw = await render(element)
      html = await normalizeString(raw)
    } catch (err) {
      html = "<div></div>"
    }

    let text = ""
    if (mod.Text && typeof mod.Text === "function") {
      try {
        const tRaw = await mod.Text(ctx)
        text = await normalizeString(tRaw)
      } catch (e) {
        text = ""
      }
    }

    if (!text && typeof html === "string") {
      text = html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim()
    }

    const subject = (Subject && typeof Subject === "function") ? await normalizeString(await Subject(ctx)) : (mod.subject || "")
    return { html, text, subject }
  }

  async send(eventName: string, eventData: Record<string, unknown>, opts: SendOpts = {}) {
    // sanitize
    const data = this.sanitize(eventData)
    // map event to template
    const mapping = EVENT_MAPPINGS[eventName]
    const templateName = mapping?.template ?? eventName.replace(/\./g, "_")

    // resolve recipient
    let to = opts.to as string | undefined
    if (!to) {
      if ((eventData as any).userId) {
        const user = await prisma.user.findUnique({ where: { id: (eventData as any).userId } })
        to = user?.email ?? undefined
      } else if ((eventData as any).email) {
        to = (eventData as any).email as string
      }
    }
    if (!to) throw new Error("no recipient resolved for mail")

    // render
    const rendered = await this.renderTemplate(templateName, { event: eventName, ...data })

    // select provider
    const active = await this.getActiveProvider()
    if (!active) throw new Error("no active mail provider configured")

    const from = (opts.from as string | undefined) ?? ((eventData as any)?.from as string | undefined) ?? ((active.config as any)?.from as string | undefined)
    const payload = { from, to, subject: rendered.subject || mapping?.subject || "", html: rendered.html, text: rendered.text }

    if (active.provider === "resend") {
      return await sendViaResend(active.config, payload)
    }
    if (active.provider === "smtp") {
      return await sendViaSmtp(active.config, payload)
    }
    throw new Error(`unknown provider ${active.provider}`)
  }

  /** Send using an explicit provider and config (does not use DB) */
  async sendWithConfig(provider: string, config: Record<string, unknown>, eventName: string, eventData: Record<string, unknown>, opts: SendOpts = {}) {
    const data = this.sanitize(eventData)
    const mapping = EVENT_MAPPINGS[eventName]
    const templateName = mapping?.template ?? eventName.replace(/\./g, "_")

    let to = opts.to as string | undefined
    if (!to) {
      if ((eventData as any).userId) {
        const user = await prisma.user.findUnique({ where: { id: (eventData as any).userId } })
        to = user?.email ?? undefined
      } else if ((eventData as any).email) {
        to = (eventData as any).email as string
      }
    }
    if (!to) throw new Error("no recipient resolved for mail")

    const rendered = await this.renderTemplate(templateName, { event: eventName, ...data })
    const from = (opts.from as string | undefined) ?? ((eventData as any)?.from as string | undefined) ?? ((config as any)?.from as string | undefined)

    const payload = { from, to, subject: rendered.subject || mapping?.subject || "", html: rendered.html, text: rendered.text }

    if (provider === "resend") {
      return await sendViaResend(config, payload)
    }
    if (provider === "smtp") {
      return await sendViaSmtp(config, payload)
    }
    throw new Error(`unknown provider ${provider}`)
  }

  // Helper to get active provider (decrypted config)
  private async getActiveProvider() {
    const integ = await prisma.mailIntegration.findFirst({ where: { enabled: true }, orderBy: { updatedAt: "desc" } })
    if (!integ) return null
    try {
      const cfg = JSON.parse(decryptSecret(integ.configEnc))
      if (integ.defaultFrom && !cfg.from) cfg.from = integ.defaultFrom
      return { provider: integ.provider, config: cfg }
    } catch (err) {
      return null
    }
  }
}

export const mailerService = new MailerService()
