import nodemailer from "nodemailer"

const transportCache = new Map<string, nodemailer.Transporter>()

export function createTransportFromConfig(cfg: { host: string; port?: number; secure?: boolean; user?: string; pass?: string }) {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`
  if (transportCache.has(key)) return transportCache.get(key) as nodemailer.Transporter
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port ?? 587,
    secure: cfg.secure ?? false,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  })
  transportCache.set(key, transport)
  return transport
}

export async function sendViaSmtp(cfg: any, payload: { from?: string; to: string; subject: string; html?: string; text?: string }) {
  const transport = createTransportFromConfig(cfg)
  const info = await transport.sendMail({
    from: payload.from ?? cfg.from ?? "noreply@example.com",
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  })
  return info
}
