import { prisma } from "../../lib/prisma"
import { encryptSecret, decryptSecret } from "../auth/crypto"
import { DEFAULT_TENANT_ID } from "../auth/identity/auth-identity.service"
import { ResendProvider } from "./providers/resend.provider"
import { SmtpProvider } from "./providers/smtp.provider"
import type { IMailProvider, MailSendOptions, MailSendResult, ResendConfig, SmtpConfig } from "./providers/types"
import { getTemplate, listTemplates, TEMPLATES } from "./templates"

export interface MailSettingsDto {
  provider: "RESEND" | "SMTP"
  enabled: boolean
  fromEmail: string
  fromName?: string
  replyTo?: string
  // Champs masqués ou entrés par l'utilisateur
  resend?: {
    apiKey?: string
    isConfigured?: boolean
  }
  smtp?: {
    host: string
    port: number
    secure: boolean
    user?: string
    pass?: string
    isConfigured?: boolean
  }
}

/**
 * Service central de gestion et d'expédition des courriels.
 *
 * Gère le cycle de vie du provider actif, le chiffrement/déchiffrement des secrets,
 * le rendu des templates React Email, et les previews avec Dummy Data.
 */
export class MailerService {
  /**
   * Récupère la configuration actuelle pour un tenant, en masquant les secrets.
   */
  async getConfig(tenantId: string = DEFAULT_TENANT_ID): Promise<MailSettingsDto | null> {
    const row = await prisma.mailIntegration.findUnique({
      where: { tenantId },
    })

    if (!row) {
      return {
        provider: "RESEND",
        enabled: false,
        fromEmail: "",
        fromName: "Hullbay Ops",
        replyTo: "",
      }
    }

    let parsedConfig: Record<string, unknown> = {}
    try {
      const decrypted = decryptSecret(row.configEnc)
      parsedConfig = JSON.parse(decrypted)
    } catch (err) {
      console.warn(`[mailer] Impossible de déchiffrer la configuration : ${err}`)
    }

    const isResend = row.provider === "RESEND"
    const isSmtp = row.provider === "SMTP"

    return {
      provider: row.provider as "RESEND" | "SMTP",
      enabled: row.enabled,
      fromEmail: row.fromEmail ?? "",
      fromName: row.fromName ?? "Hullbay Ops",
      replyTo: row.replyTo ?? "",
      resend: isResend
        ? {
            apiKey: parsedConfig.apiKey ? "••••••••••••••••" : "",
            isConfigured: Boolean(parsedConfig.apiKey),
          }
        : undefined,
      smtp: isSmtp
        ? {
            host: String(parsedConfig.host || ""),
            port: Number(parsedConfig.port || 587),
            secure: Boolean(parsedConfig.secure),
            user: String(parsedConfig.user || ""),
            pass: parsedConfig.pass ? "••••••••" : "",
            isConfigured: Boolean(parsedConfig.host),
          }
        : undefined,
    }
  }

  /**
   * Enregistre ou met à jour la configuration mail d'un tenant.
   * Les secrets sont chiffrés via encryptSecret avant persistance.
   */
  async saveConfig(
    tenantId: string = DEFAULT_TENANT_ID,
    dto: {
      provider: "RESEND" | "SMTP"
      enabled: boolean
      fromEmail: string
      fromName?: string
      replyTo?: string
      resend?: { apiKey?: string }
      smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string }
    }
  ): Promise<{ ok: boolean }> {
    // Récupérer l'existant pour préserver un mot de passe non modifié (masqué)
    const existing = await prisma.mailIntegration.findUnique({
      where: { tenantId },
    })

    let existingConfig: Record<string, any> = {}
    if (existing) {
      try {
        existingConfig = JSON.parse(decryptSecret(existing.configEnc))
      } catch {
        // Ignorer l'erreur de déchiffrement lors d'une nouvelle saisie
      }
    }

    let finalConfig: Record<string, any> = {}

    if (dto.provider === "RESEND") {
      const newKey = dto.resend?.apiKey?.trim()
      // Si la clé entrée est "••••••••" (masquée), on garde l'existante
      const keyToSave = newKey && !newKey.startsWith("••") ? newKey : existingConfig.apiKey
      finalConfig = { apiKey: keyToSave || "" }
    } else {
      const newPass = dto.smtp?.pass?.trim()
      const passToSave = newPass && !newPass.startsWith("••") ? newPass : existingConfig.pass
      finalConfig = {
        host: dto.smtp?.host?.trim() || existingConfig.host || "",
        port: Number(dto.smtp?.port || existingConfig.port || 587),
        secure: dto.smtp?.secure ?? existingConfig.secure ?? false,
        user: dto.smtp?.user?.trim() ?? existingConfig.user ?? "",
        pass: passToSave || "",
      }
    }

    const encrypted = encryptSecret(JSON.stringify(finalConfig))

    await prisma.mailIntegration.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: dto.provider,
        enabled: dto.enabled,
        fromEmail: dto.fromEmail?.trim(),
        fromName: dto.fromName?.trim() || "Hullbay Ops",
        replyTo: dto.replyTo?.trim() || null,
        configEnc: encrypted,
      },
      update: {
        provider: dto.provider,
        enabled: dto.enabled,
        fromEmail: dto.fromEmail?.trim(),
        fromName: dto.fromName?.trim() || "Hullbay Ops",
        replyTo: dto.replyTo?.trim() || null,
        configEnc: encrypted,
      },
    })

    return { ok: true }
  }

  /**
   * Instancie le provider actif avec les identifiants déchiffrés.
   */
  async getActiveProvider(tenantId: string = DEFAULT_TENANT_ID): Promise<{
    provider: IMailProvider
    from: string
    replyTo?: string
  } | null> {
    const row = await prisma.mailIntegration.findUnique({
      where: { tenantId },
    })

    if (!row || !row.enabled) return null

    let parsedConfig: Record<string, any> = {}
    try {
      parsedConfig = JSON.parse(decryptSecret(row.configEnc))
    } catch (err) {
      console.error(`[mailer] Échec du déchiffrement des credentials : ${err}`)
      return null
    }

    const fromAddress = row.fromName ? `"${row.fromName}" <${row.fromEmail}>` : row.fromEmail || ""

    if (row.provider === "RESEND") {
      if (!parsedConfig.apiKey) return null
      return {
        provider: new ResendProvider({ apiKey: parsedConfig.apiKey }),
        from: fromAddress,
        replyTo: row.replyTo || undefined,
      }
    }

    if (row.provider === "SMTP") {
      if (!parsedConfig.host) return null
      return {
        provider: new SmtpProvider({
          host: parsedConfig.host,
          port: Number(parsedConfig.port || 587),
          secure: Boolean(parsedConfig.secure),
          user: parsedConfig.user,
          pass: parsedConfig.pass,
        }),
        from: fromAddress,
        replyTo: row.replyTo || undefined,
      }
    }

    return null
  }

  /**
   * Effectue le rendu et l'envoi d'un e-mail d'après un nom de template et ses données.
   */
  async send(
    templateId: string,
    data: any,
    options: {
      to: string | string[]
      subject?: string
      tenantId?: string
      cc?: string | string[]
      bcc?: string | string[]
    }
  ): Promise<MailSendResult> {
    const template = getTemplate(templateId)
    if (!template) {
      return { ok: false, error: `Template d'e-mail introuvable : ${templateId}` }
    }

    const active = await this.getActiveProvider(options.tenantId || DEFAULT_TENANT_ID)
    if (!active) {
      // Le service mail n'est pas activé ou configuré pour ce tenant
      return { ok: false, error: "Aucun service d'e-mail actif ou activé pour cette organisation." }
    }

    try {
      const html = await template.renderHtml(data)
      const text = await template.renderText(data)
      const subject = options.subject || template.defaultSubject(data)

      const sendOptions: MailSendOptions = {
        to: options.to,
        from: active.from,
        replyTo: active.replyTo,
        subject,
        html,
        text,
        cc: options.cc,
        bcc: options.bcc,
      }

      return await active.provider.send(sendOptions)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Erreur lors de la préparation du template : ${msg}` }
    }
  }

  /**
   * Génère la prévisualisation HTML d'un template avec ses données factices (Dummy Data).
   */
  async getTemplatePreview(templateId: string, variant?: string): Promise<{ html: string; subject: string }> {
    const template = getTemplate(templateId)
    if (!template) {
      throw new Error(`Template inconnu : ${templateId}`)
    }

    let propsToUse = template.previewProps
    if (variant && template.additionalPreviews && template.additionalPreviews[variant]) {
      propsToUse = template.additionalPreviews[variant]
    }

    const html = await template.renderHtml(propsToUse)
    const subject = template.defaultSubject(propsToUse)

    return { html, subject }
  }

  /**
   * Liste les templates et leurs informations de métadonnées.
   */
  listTemplates() {
    return listTemplates()
  }
}

export const mailerService = new MailerService()
