import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { eventBus } from "../../lib/event-bus"
import { prisma } from "../../lib/prisma"
import { currentUser, requireRole } from "../auth/rbac"
import type { TenantScopedRequest } from "../auth/tenancy/tenant-resolver"
import { mailerService } from "./service"

const owner = { preHandler: requireRole("owner") }

const saveMailSchema = z.object({
  provider: z.enum(["RESEND", "SMTP"]),
  enabled: z.boolean(),
  fromEmail: z.string().email("Adresse expéditeur invalide"),
  fromName: z.string().optional(),
  replyTo: z.string().email("Adresse de réponse invalide").optional().or(z.literal("")),
  resend: z
    .object({
      apiKey: z.string().optional(),
    })
    .optional(),
  smtp: z
    .object({
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().optional(),
      pass: z.string().optional(),
    })
    .optional(),
})

/**
 * Routes d'administration du service de messagerie.
 *
 * Réservées aux utilisateurs ayant le rôle "owner" au sein du tenant.
 * Conforme au principe de découplage : le bouton "Tester" émet l'événement `mail.test`
 * sans exécuter d'envoi synchrone bloquant dans la route.
 */
export async function registerMailerRoutes(app: FastifyInstance) {
  // ── 1. Consultation de la configuration active (masquée) ──
  app.get(
    "/api/settings/mail",
    {
      ...owner,
      schema: {
        tags: ["settings", "mailer"],
        summary: "Lire la configuration e-mail active (masquée)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const tenantId = (req as TenantScopedRequest).tenantId
      return mailerService.getConfig(tenantId)
    }
  )

  // ── 2. Sauvegarde de la configuration (chiffrement des identifiants) ──
  app.post(
    "/api/settings/mail",
    {
      ...owner,
      schema: {
        tags: ["settings", "mailer"],
        summary: "Mettre à jour la configuration e-mail du tenant",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const tenantId = (req as TenantScopedRequest).tenantId
      const parsed = saveMailSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: parsed.error.issues[0]?.message ?? "Payload invalide",
        })
      }

      await mailerService.saveConfig(tenantId, parsed.data)
      return { ok: true }
    }
  )

  // ── 3. Déclenchement d'un test d'envoi (vérification et retour d'erreur immédiat) ──
  app.post(
    "/api/settings/mail/test",
    {
      ...owner,
      schema: {
        tags: ["settings", "mailer"],
        summary: "Déclencher l'envoi d'un e-mail de test (vérification immédiate)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const tenantId = (req as TenantScopedRequest).tenantId
      const user = currentUser(req)
      const userId = user?.sub
      let targetEmail = (req.body as any)?.email

      if (!targetEmail && userId) {
        const u = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        })
        targetEmail = u?.email
      }

      if (!targetEmail) {
        return reply.code(400).send({
          ok: false,
          error: "Aucune adresse e-mail de destination trouvée pour l'utilisateur connecté.",
        })
      }

      // Émission de l'événement pour audit
      await eventBus.emit("mail.test", {
        userId,
        email: targetEmail,
        tenantId,
        origin: "ui.test-button",
      })

      // Vérification que le service est activé
      const config = await mailerService.getConfig(tenantId)
      if (!config || !config.enabled) {
        return reply.code(400).send({
          ok: false,
          error: "Le service d'e-mails est actuellement désactivé. Veuillez l'activer et enregistrer la configuration avant de tester.",
        })
      }

      if (!config.fromEmail) {
        return reply.code(400).send({
          ok: false,
          error: "L'adresse expéditeur (From) est obligatoire pour effectuer un envoi.",
        })
      }

      const testedByName = userId
        ? (await prisma.user.findUnique({ where: { id: userId } }))?.email || targetEmail
        : targetEmail

      // Envoi synchrone pour rapporter fidèlement l'état réel (succès ou erreur du provider)
      const result = await mailerService.send(
        "mail.test",
        {
          provider: config.provider,
          testedBy: testedByName,
          sentAt: new Date().toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
          fromAddress: config.fromEmail,
          replyTo: config.replyTo,
        },
        {
          to: targetEmail,
          tenantId,
        }
      )

      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          error: result.error || "Échec de l'envoi via le fournisseur sélectionné.",
        })
      }

      return {
        ok: true,
        message: `E-mail de test envoyé avec succès à ${targetEmail} via ${config.provider}.`,
        messageId: result.messageId,
      }
    }
  )

  // ── 4. Liste des templates disponibles ──
  app.get(
    "/api/settings/mail/templates",
    {
      ...owner,
      schema: {
        tags: ["settings", "mailer"],
        summary: "Lister les templates disponibles avec leurs prévisualisations",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => {
      return mailerService.listTemplates()
    }
  )

  // ── 5. Prévisualisation HTML d'un template (avec dummy data) ──
  app.get(
    "/api/settings/mail/templates/:id/preview",
    {
      ...owner,
      schema: {
        tags: ["settings", "mailer"],
        summary: "Obtenir le rendu HTML prévisualisé d'un template (dummy data)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { variant } = (req.query as { variant?: string }) || {}

      try {
        const preview = await mailerService.getTemplatePreview(id, variant)
        return reply.type("text/html; charset=utf-8").send(preview.html)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return reply.code(404).send({ ok: false, error: msg })
      }
    }
  )
}
