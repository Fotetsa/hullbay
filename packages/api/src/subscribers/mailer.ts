import { eventBus } from "../lib/event-bus"
import { mailerService } from "../modules/mailer/service"
import { prisma } from "../lib/prisma"

export function registerMailSubscribers(): void {
  if ((registerMailSubscribers as { __registered?: boolean }).__registered) return

  const resolveRecipient = async (email?: string, userId?: string) => {
    if (email) return email
    if (!userId) return undefined
    const user = await prisma.user.findUnique({ where: { id: userId } })
    return user?.email ?? undefined
  }

  const resolveOwnerRecipients = async () => {
    const owners = await prisma.user.findMany({ where: { role: "owner" }, select: { email: true } })
    return [...new Set(owners.map((u) => u.email).filter(Boolean) as string[])]
  }

  const resolveTargetRecipients = async (
    targetUserId?: string,
    actorUserId?: string,
    allowOwners = true,
    targetEmailOverride?: string,
    includeActor = true,
  ) => {
    const recipients = new Set<string>()
    const targetEmail = targetEmailOverride ?? (targetUserId ? await resolveRecipient(undefined, targetUserId) : undefined)
    if (targetEmail) recipients.add(targetEmail)
    if (includeActor) {
      const actorEmail = actorUserId ? await resolveRecipient(undefined, actorUserId) : undefined
      if (actorEmail) recipients.add(actorEmail)
    }
    if (allowOwners) {
      for (const email of await resolveOwnerRecipients()) recipients.add(email)
    }
    return [...recipients]
  }

  const emitEventMail = async (eventName: string, payload: Record<string, unknown>, recipients: string[]) => {
    const addresses = [...new Set(recipients.filter(Boolean))]
    if (!addresses.length) {
      console.warn("[mailer] %s skipped: no recipient", eventName)
      return
    }
    for (const to of addresses) {
      try {
        await mailerService.send(eventName, payload, { to })
      } catch (err) {
        console.error(`[mailer] ${eventName} send failed:`, err)
      }
    }
  }

  // Test send endpoint -> perform an actual send via mailerService
  eventBus.on("mail.test", async (evt) => {
    const d = evt.data as { email?: string; name?: string; userId?: string; locale?: string }
    const to = await resolveRecipient(d.email, d.userId)
    if (!to) return
    const ctx = { name: d.name, locale: d.locale }
    try {
      await mailerService.send("mail.test", ctx, { to })
    } catch (err) {
      console.error("[mailer] mail.test send failed:", err)
    }
  })

  eventBus.on("deploy.finished", async (evt) => {
    const d = evt.data as { projectId?: string; ok?: boolean; userId?: string; email?: string }
    const to = await resolveRecipient(d.email, d.userId)
    if (!to) {
      console.warn("[mailer] deploy.finished skipped: no recipient for userId=%s email=%s", d.userId ?? "none", d.email ?? "none")
      return
    }
    try {
      await mailerService.send("deploy.finished", { ok: d.ok, projectId: d.projectId, userId: d.userId }, { to })
    } catch (err) {
      console.error("[mailer] deploy.finished send failed:", err)
    }
  })

  eventBus.on("user.created", async (evt) => {
    const d = evt.data as { targetUserId?: string; email?: string; userId?: string; role?: string }
    const recipients = await resolveTargetRecipients(d.targetUserId, d.userId, true, d.email)
    await emitEventMail("user.created", { email: d.email, role: d.role, actorUserId: d.userId, targetUserId: d.targetUserId }, recipients)
  })

  eventBus.on("user.role.changed", async (evt) => {
    const d = evt.data as { targetUserId?: string; userId?: string; role?: string; email?: string }
    const recipients = await resolveTargetRecipients(d.targetUserId, d.userId, false, d.email, false)
    await emitEventMail("user.role.changed", { role: d.role, targetUserId: d.targetUserId, actorUserId: d.userId, email: d.email }, recipients)
  })

  eventBus.on("user.deleted", async (evt) => {
    const d = evt.data as { targetUserId?: string; userId?: string; targetEmail?: string }
    const recipients = await resolveTargetRecipients(d.targetUserId, d.userId, true, d.targetEmail)
    await emitEventMail("user.deleted", { targetUserId: d.targetUserId, actorUserId: d.userId, email: d.targetEmail }, recipients)
  })

  eventBus.on("server.provisioned", async (evt) => {
    const d = evt.data as { serverId?: string; userId?: string }
    const recipients = await resolveTargetRecipients(undefined, d.userId)
    await emitEventMail("server.provisioned", { serverId: d.serverId, actorUserId: d.userId }, recipients)
  })

  eventBus.on("server.removed", async (evt) => {
    const d = evt.data as { serverId?: string; userId?: string }
    const recipients = await resolveTargetRecipients(undefined, d.userId)
    await emitEventMail("server.removed", { serverId: d.serverId, actorUserId: d.userId }, recipients)
  })

  eventBus.on("server.role.changed", async (evt) => {
    const d = evt.data as { serverId?: string; userId?: string; role?: string }
    const recipients = await resolveTargetRecipients(undefined, d.userId)
    await emitEventMail("server.role.changed", { serverId: d.serverId, role: d.role, actorUserId: d.userId }, recipients)
  })

  eventBus.on("registry.set", async (evt) => {
    const d = evt.data as { userId?: string; registry?: string }
    const recipients = await resolveTargetRecipients(undefined, d.userId)
    await emitEventMail("registry.set", { registry: d.registry, actorUserId: d.userId }, recipients)
  })

  eventBus.on("secret.set", async (evt) => {
    const d = evt.data as { userId?: string; clusterId?: string; name?: string }
    const recipients = await resolveTargetRecipients(undefined, d.userId)
    await emitEventMail("secret.set", { clusterId: d.clusterId, name: d.name, actorUserId: d.userId }, recipients)
  })

  eventBus.on("secret.removed", async (evt) => {
    const d = evt.data as { userId?: string; clusterId?: string; name?: string }
    const recipients = await resolveTargetRecipients(undefined, d.userId)
    await emitEventMail("secret.removed", { clusterId: d.clusterId, name: d.name, actorUserId: d.userId }, recipients)
  })

  ;(registerMailSubscribers as { __registered?: boolean }).__registered = true
}
