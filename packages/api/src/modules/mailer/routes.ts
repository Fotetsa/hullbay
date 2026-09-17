import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { requireRole, currentUser } from "../auth/rbac"
import { encryptSecret } from "../auth/crypto"
import { prisma } from "../../lib/prisma"
import { eventBus } from "../../lib/event-bus"

const owner = { preHandler: requireRole("owner") }

export async function registerMailerRoutes(app: FastifyInstance) {
  app.get(
    "/api/settings/mail",
    {
      ...owner,
      schema: { tags: ["settings"], summary: "Lire la config mail (owner)" },
    },
    async () => {
      const list = await prisma.mailIntegration.findMany({ orderBy: { updatedAt: "desc" } })
      return list.map((l) => ({ id: l.id, provider: l.provider, enabled: l.enabled, defaultFrom: l.defaultFrom, createdAt: l.createdAt }))
    },
  )

  const saveSchema = z.object({ provider: z.string(), config: z.record(z.any()), enabled: z.boolean().optional(), defaultFrom: z.string().optional() })

  app.post(
    "/api/settings/mail",
    {
      ...owner,
      schema: { body: saveSchema, tags: ["settings"], summary: "Sauvegarder la config mail (owner)" },
    },
    async (req, reply) => {
      const body = req.body as { provider: string; config: Record<string, unknown>; enabled?: boolean; defaultFrom?: string }
      try {
        const enc = encryptSecret(JSON.stringify(body.config))
        const up = await prisma.mailIntegration.upsert({ where: { id: body.provider }, create: { id: body.provider, provider: body.provider, configEnc: enc, enabled: body.enabled ?? true, defaultFrom: body.defaultFrom }, update: { configEnc: enc, enabled: body.enabled ?? true, defaultFrom: body.defaultFrom } })
        await eventBus.emit("settings.mail.updated", { userId: currentUser(req)?.sub, provider: up.provider })
        return { ok: true }
      } catch (err) {
        app.log.error({ err, body }, "mail.test failed")
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  const testSchema = z.object({
    to: z.string().email(),
    from: z.string().email().optional(),
    eventName: z.string().optional(),
    name: z.string().optional(),
    locale: z.enum(["fr", "en"]).optional(),
    // optional transient provider/config for testing before save
    provider: z.string().optional(),
    config: z.record(z.any()).optional(),
  })

  app.post(
    "/api/settings/mail/test",
    {
      ...owner,
      schema: { body: testSchema, tags: ["settings"], summary: "Tester l'envoi mail (owner)" },
    },
    async (req, reply) => {
      const body = req.body as { to: string; from?: string; eventName?: string; name?: string; locale?: "fr" | "en"; provider?: string; config?: Record<string, unknown> }
      try {
        if (body.provider && body.config) {
          // perform a one-off send without saving config
          const nextConfig = { ...body.config, ...(body.from ? { from: body.from } : {}) }
          const { mailerService } = (await import("./service")) as typeof import("./service")
          await mailerService.sendWithConfig(body.provider, nextConfig, body.eventName ?? "mail.test", { email: body.to, name: body.name, from: body.from, locale: body.locale }, { to: body.to, from: body.from })
          return { ok: true }
        }

        await eventBus.emit("mail.test", { userId: currentUser(req)?.sub, email: body.to, name: body.name, from: body.from, locale: body.locale, eventName: body.eventName ?? "mail.test" })
        return { ok: true }
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )
}
