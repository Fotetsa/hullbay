export type MailLocale = "fr" | "en"

export function resolveMailLocale(locale?: string | null): MailLocale {
  return locale === "fr" ? "fr" : "en"
}

export function getMailText<T>(locale: string | null | undefined, values: { fr: T; en: T }): T {
  return values[resolveMailLocale(locale)]
}
