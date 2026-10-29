/**
 * Types et interfaces pour les fournisseurs de messagerie (Resend et SMTP).
 */

export interface ResendConfig {
  apiKey: string
}

export interface SmtpConfig {
  host: string
  port: number
  secure?: boolean // true pour SSL port 465, false pour TLS/STARTTLS port 587 ou 25
  user?: string
  pass?: string
}

export interface MailSendOptions {
  to: string | string[]
  subject: string
  html: string
  text?: string
  from?: string
  replyTo?: string
  cc?: string | string[]
  bcc?: string | string[]
}

export interface MailSendResult {
  ok: boolean
  messageId?: string
  error?: string
}

export interface IMailProvider {
  readonly name: "RESEND" | "SMTP"
  /**
   * Vérifie la validité des accès / connectivité réseau vers le service d'e-mail.
   */
  verify(): Promise<{ ok: boolean; error?: string }>
  /**
   * Expédie un e-mail avec le payload HTML et texte généré.
   */
  send(options: MailSendOptions): Promise<MailSendResult>
}
