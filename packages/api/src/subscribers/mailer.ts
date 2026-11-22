import { eventBus, type OpsEvent } from "../lib/event-bus"
import { prisma } from "../lib/prisma"
import { DEFAULT_TENANT_ID } from "../modules/auth/identity/auth-identity.service"
import { mailerService } from "../modules/mailer"

/**
 * Cache anti-spam / déduplication en mémoire (lastSent[eventKey:recipient]).
 * Évite les rafales d'e-mails pour les événements récurrents (ex. dérives répétées).
 */
const lastSentTimestamps = new Map<string, number>()
const THROTTLE_WINDOW_MS = 60_000 // 1 minute par événement/destinataire identique

function isThrottled(eventKey: string, recipient: string): boolean {
  const key = `${eventKey}:${recipient}`
  const now = Date.now()
  const last = lastSentTimestamps.get(key)
  if (last && now - last < THROTTLE_WINDOW_MS) {
    return true
  }
  lastSentTimestamps.set(key, now)
  return false
}

/**
 * Subscriber centralisé pour l'expédition d'e-mails via le bus d'événements.
 *
 * Découplage strict : aucun contrôleur ni workflow n'appelle directement le service
 * d'e-mail. Tous les envois sont régis par les événements émis sur `eventBus`.
 */
export function registerMailerSubscribers(): void {
  // ── 1. E-mail de test (déclenché depuis les paramètres) ──
  eventBus.on("mail.test", async (event: OpsEvent) => {
    // Si l'origine provient de l'interface utilisateur, la route a déjà effectué l'envoi synchrone pour rapporter le statut.
    if ((event.data as any)?.origin === "ui.test-button") return

    const { userId, email, tenantId } = event.data as {
      userId?: string
      email?: string
      tenantId?: string
    }

    const recipient = email || (userId ? await resolveEmailFromUserId(userId) : null)
    if (!recipient) {
      console.warn("[mailer-subscriber] Événement mail.test ignoré : aucun destinataire résolu.")
      return
    }

    const config = await mailerService.getConfig(tenantId || DEFAULT_TENANT_ID)
    const testedByName = userId ? await resolveUserNameFromUserId(userId) : recipient

    await mailerService.send(
      "mail.test",
      {
        provider: config?.provider || "RESEND",
        testedBy: testedByName,
        sentAt: new Date().toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
        fromAddress: config?.fromEmail || "non-configuré",
        replyTo: config?.replyTo,
      },
      {
        to: recipient,
        tenantId: tenantId || DEFAULT_TENANT_ID,
      }
    )
  })

  // ── 2. Déploiement terminé (Succès ou Échec) avec rapport exhaustif ──
  eventBus.on("deploy.finished", async (event: OpsEvent) => {
    const d = event.data as {
      projectId?: string
      userId?: string
      tenantId?: string
      ok?: boolean
      error?: string
      log?: string[]
      durationSec?: number
    }

    if (!d.projectId) return

    const tenantId = d.tenantId || DEFAULT_TENANT_ID

    // Vérifier si le mailer est activé pour ce tenant avant requêtes DB
    const mailConfig = await mailerService.getConfig(tenantId)
    if (!mailConfig?.enabled) return

    // Récupérer les détails complets du projet et de sa topologie
    const project = await prisma.project.findUnique({
      where: { id: d.projectId },
      include: {
        cluster: true,
        nodes: true,
      },
    })

    if (!project) return

    const executedByName = d.userId
      ? await resolveUserNameFromUserId(d.userId)
      : "Orchestrateur automatique"

    // Récupérer les destinataires du tenant (Owners et Operators)
    const recipients = await resolveTenantNotificationRecipients(tenantId)
    if (recipients.length === 0) return

    const servicesCount = project.nodes.filter((n) => n.type === "container").length

    const payload = {
      projectName: project.name,
      projectSlug: project.slug,
      clusterName: project.cluster?.name || "Cluster Docker Swarm",
      ok: Boolean(d.ok),
      executedBy: executedByName,
      timestamp: new Date().toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
      durationSec: d.durationSec,
      log: d.log || [],
      error: d.error ? String(d.error) : undefined,
      servicesSummary: {
        total: servicesCount,
        created: d.ok ? servicesCount : 0,
      },
      dashboardUrl: `${process.env.PUBLIC_URL || "http://localhost:5173"}/projects/${project.slug}`,
    }

    for (const to of recipients) {
      if (isThrottled(`deploy.finished:${project.id}`, to)) continue

      await mailerService.send("deploy.finished", payload, {
        to,
        tenantId,
      }).catch((err) => {
        console.error(`[mailer-subscriber] Erreur d'envoi rapport déploiement à ${to} : ${err}`)
      })
    }
  })

  // ── 3. Changement de mot de passe utilisateur ──
  eventBus.on("auth.password.changed", async (event: OpsEvent) => {
    const { userId, tenantId, ip } = event.data as {
      userId?: string
      tenantId?: string
      ip?: string
    }

    if (!userId) return

    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user?.email) return

    await mailerService.send(
      "password.changed",
      {
        userName: user.email.split("@")[0] || "Utilisateur",
        userEmail: user.email,
        changedAt: new Date().toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
        ipAddress: ip || "Non renseignée",
        resetUrl: `${process.env.PUBLIC_URL || "http://localhost:5173"}/reset-password`,
      },
      {
        to: user.email,
        tenantId: tenantId || DEFAULT_TENANT_ID,
      }
    ).catch(() => {})
  })

  // ── 4. Alerte de dérive d'infrastructure (Drift) ──
  eventBus.on("drift.detected", async (event: OpsEvent) => {
    const d = event.data as {
      clusterId?: string
      tenantId?: string
      diffCount?: number
      diffs?: Array<{ target: string; reason: string; severity?: "low" | "medium" | "high" }>
    }

    const tenantId = d.tenantId || DEFAULT_TENANT_ID
    const mailConfig = await mailerService.getConfig(tenantId)
    if (!mailConfig?.enabled) return

    const recipients = await resolveTenantNotificationRecipients(tenantId)
    if (recipients.length === 0) return

    const cluster = d.clusterId
      ? await prisma.cluster.findUnique({ where: { id: d.clusterId } })
      : null

    const formattedDiffs = (d.diffs || []).map((item) => ({
      target: item.target,
      reason: item.reason,
      severity: item.severity || "medium",
    }))

    for (const to of recipients) {
      if (isThrottled(`drift:${d.clusterId || "global"}`, to)) continue

      await mailerService.send(
        "drift.alert",
        {
          clusterName: cluster?.name || "Cluster Swarm",
          detectedAt: new Date().toLocaleString("fr-FR", { timeZone: "UTC" }) + " UTC",
          diffCount: d.diffCount || formattedDiffs.length || 1,
          diffs: formattedDiffs,
          reconcileUrl: `${process.env.PUBLIC_URL || "http://localhost:5173"}/health`,
        },
        {
          to,
          tenantId,
        }
      ).catch(() => {})
    }
  })
}

// ── Utilitaires de résolution ──

async function resolveEmailFromUserId(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  })
  return user?.email || null
}

async function resolveUserNameFromUserId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  })
  return user?.email || "Opérateur"
}

/**
 * Récupère les e-mails des membres ayant les rôles "owner" ou "operator" sur un tenant.
 */
async function resolveTenantNotificationRecipients(tenantId: string): Promise<string[]> {
  const memberships = await prisma.membership.findMany({
    where: {
      tenantId,
      role: { in: ["owner", "operator"] },
    },
    include: {
      user: {
        select: { email: true },
      },
    },
  })

  return memberships
    .map((m) => m.user?.email)
    .filter((email): email is string => Boolean(email && email.includes("@")))
}
