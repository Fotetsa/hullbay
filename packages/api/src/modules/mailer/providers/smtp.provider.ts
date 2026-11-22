import nodemailer, { type Transporter } from "nodemailer"
import type { IMailProvider, MailSendOptions, MailSendResult, SmtpConfig } from "./types"

/**
 * Provider SMTP basé sur Nodemailer.
 *
 * Supporte les serveurs SMTP sécurisés (port 465 SSL, 587 STARTTLS) ainsi que
 * les relais SMTP locaux internes au cluster Swarm sans authentification.
 */
export class SmtpProvider implements IMailProvider {
  readonly name = "SMTP" as const
  private transporter: Transporter

  constructor(config: SmtpConfig) {
    const isSecure = config.secure ?? config.port === 465

    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: isSecure,
      auth:
        config.user && config.pass
          ? {
              user: config.user,
              pass: config.pass,
            }
          : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 5_000,
      socketTimeout: 15_000,
    })
  }

  /**
   * Vérifie la connexion SMTP (handshake, TLS, et identifiants).
   */
  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.transporter.verify()
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Échec de validation SMTP : ${msg}` }
    }
  }

  /**
   * Expédie un e-mail via le transporteur SMTP configuré.
   */
  async send(options: MailSendOptions): Promise<MailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: options.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        replyTo: options.replyTo,
        cc: options.cc,
        bcc: options.bcc,
      })

      return {
        ok: true,
        messageId: info.messageId,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: `Erreur d'expédition SMTP : ${msg}`,
      }
    }
  }
}
