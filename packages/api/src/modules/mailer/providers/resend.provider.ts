import type { IMailProvider, MailSendOptions, MailSendResult, ResendConfig } from "./types"

/**
 * Provider Resend basé sur l'API HTTP officielle (POST https://api.resend.com/emails).
 *
 * L'utilisation de fetch natif évite les instanciations lourdes et permet
 * d'intercepter précisément les codes d'erreur HTTP de Resend (401, 422, 429 rate limit).
 */
export class ResendProvider implements IMailProvider {
  readonly name = "RESEND" as const
  private apiKey: string

  constructor(config: ResendConfig) {
    this.apiKey = config.apiKey.trim()
  }

  /**
   * Vérifie la validité de la clé API via l'endpoint de consultation des clés API Resend.
   */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    if (!this.apiKey) {
      return { ok: false, error: "Clé API Resend non renseignée." }
    }

    try {
      const res = await fetch("https://api.resend.com/api-keys", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })

      if (res.ok) {
        return { ok: true }
      }

      if (res.status === 401) {
        return { ok: false, error: "Clé API Resend invalide ou révoquée (401 Unauthorized)." }
      }

      const body = (await res.json().catch(() => ({}))) as { message?: string }
      return {
        ok: false,
        error: body.message || `Erreur de vérification Resend (HTTP ${res.status}).`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Impossible de contacter l'API Resend : ${msg}` }
    }
  }

  /**
   * Envoi d'un courriel via Resend.
   */
  async send(options: MailSendOptions): Promise<MailSendResult> {
    try {
      const to = Array.isArray(options.to) ? options.to : [options.to]
      const payload: Record<string, unknown> = {
        from: options.from,
        to,
        subject: options.subject,
        html: options.html,
      }

      if (options.text) payload.text = options.text
      if (options.replyTo) payload.reply_to = options.replyTo
      if (options.cc) payload.cc = Array.isArray(options.cc) ? options.cc : [options.cc]
      if (options.bcc) payload.bcc = Array.isArray(options.bcc) ? options.bcc : [options.bcc]

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
      })

      const data = (await res.json().catch(() => ({}))) as {
        id?: string
        message?: string
        statusCode?: number
        name?: string
      }

      if (!res.ok) {
        const errorMsg = data.message || `Échec Resend HTTP ${res.status}`
        return { ok: false, error: errorMsg }
      }

      return {
        ok: true,
        messageId: data.id,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Erreur inattendue lors de l'envoi Resend : ${msg}` }
    }
  }
}
