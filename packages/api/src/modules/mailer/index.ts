/**
 * Module Mailer de Hullbay : intégration Resend & SMTP avec React Email.
 */
export { mailerService, MailerService } from "./service"
export { registerMailerRoutes } from "./routes"
export { TEMPLATES, getTemplate, listTemplates } from "./templates"
export type { MailSettingsDto } from "./service"
export type { IMailProvider, MailSendOptions, MailSendResult } from "./providers/types"
