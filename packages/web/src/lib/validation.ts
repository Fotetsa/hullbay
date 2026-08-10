export function isValidDomain(value: string): boolean {
  const domain = value.trim().toLowerCase()
  if (!domain || domain.length > 253) return false
  const parts = domain.split(".")
  if (parts.length < 2) return false

  const tld = parts[parts.length - 1]
  if (!/^[a-z]{2,63}$/.test(tld)) return false

  return parts.every((label) => {
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  })
}
