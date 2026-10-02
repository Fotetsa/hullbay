export type ParsedEnvEntry = {
  key: string
  value: string
}

export const VALID_SECRET_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export function normalizeSecretName(name: string): string {
  return String(name).trim()
}

export function isValidSecretName(name: string): boolean {
  const normalized = normalizeSecretName(name)
  if (!normalized || normalized.includes("..")) return false
  return VALID_SECRET_NAME_RE.test(normalized)
}

export function isAllowedSecretImport(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
  return ["env", "txt", "md"].includes(ext)
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
