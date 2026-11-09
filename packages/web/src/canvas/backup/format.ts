/** Helpers d'affichage du module sauvegarde (aucune dépendance UI). */

export function formatBytes(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—"
  const bytes = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} o`
  const units = ["Ko", "Mo", "Go", "To", "Po"]
  let size = bytes
  let unit = -1
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  const digits = size >= 10 ? 0 : 1
  return `${size.toFixed(digits)} ${units[unit]}`
}

export function formatDate(value: string | null | undefined, language: string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(language, {
    dateStyle: "short",
    timeStyle: "short",
  })
}

/** Empreinte courte lisible : 12 premiers caractères hexadécimaux. */
export function shortChecksum(value: string | null | undefined): string {
  if (!value) return "—"
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}
