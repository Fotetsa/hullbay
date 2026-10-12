export type ParsedEnvEntry = {
  key: string
  value: string
}

export const VALID_SECRET_NAME_RE = /^[A-Za-z0-9_.-]+$/

export function isValidSecretName(name: string): boolean {
  return VALID_SECRET_NAME_RE.test(String(name).trim())
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }

  return value
}

export function parseEnvContent(raw: string): ParsedEnvEntry[] {
  const entries = new Map<string, string>()

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const cleaned = trimmed.replace(/^export\s+/i, "")
    const index = cleaned.indexOf("=")
    if (index === -1) continue

    const key = cleaned.slice(0, index).trim()
    const rawValue = cleaned.slice(index + 1).trim()
    if (!key) continue

    const value = stripQuotes(rawValue)
    entries.set(key, value)
  }

  return Array.from(entries.entries()).map(([key, value]) => ({ key, value }))
}
