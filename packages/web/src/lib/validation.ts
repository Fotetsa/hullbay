export function isValidDomain(value: string): boolean {
  const domain = value.trim().toLowerCase();
  if (!domain || domain.length > 253) return false;
  const parts = domain.split(".");
  if (parts.length < 2) return false;

  const tld = parts[parts.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld)) return false;

  return parts.every((label) => {
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
  });
}

const HOSTNAME_OR_IP_REGEX =
  /^(([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|(\d{1,3}\.){3}\d{1,3})$/;

export function isValidHostnameOrIp(value: string): boolean {
  return HOSTNAME_OR_IP_REGEX.test(value.trim());
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isValidClusterName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length >= 2 &&
    trimmed.length <= 63 &&
    /^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(trimmed)
  );
}