declare module "nodemailer" {
  export type SendMailOptions = {
    from?: string
    to: string | string[]
    subject: string
    html?: string
    text?: string
  }

  export interface SentMessageInfo {
    messageId: string
    envelope?: unknown
    accepted?: string[]
    rejected?: string[]
    pending?: string[]
    response?: string
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<SentMessageInfo>
  }

  export function createTransport(config: any): Transporter
}
