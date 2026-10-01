/**
 * Champs de configuration "gérés par Hullbay" : dérivés du contexte du tenant,
 * jamais demandés à l'utilisateur. L'utilisateur peut conserver un override
 * explicite (valeur déjà présente) — sinon la valeur est calculée.
 *
 * Base publique résolue dans l'ordre :
 *  1. domaine du tenant (Settings) — source de vérité public en prod.
 *  2. PUBLIC_HOST (déploiement sans domaine encore posé).
 *  3. dev/test : http://localhost:<API_PORT>.
 *  Aucune base en prod sans domaine → champs non posés (le garde-fou domaine
 *  interdit déjà d'activer ces providers dans ce cas).
 */

import { settingsService } from "../../settings/service"
import { DEFAULT_TENANT_ID } from "../identity/auth-identity.service"

function isProdLike(): boolean {
  const env = process.env.NODE_ENV
  return env !== "development" && env !== "test"
}

/** Discovery OIDC par défaut : issuer + "/.well-known/openid-configuration". */
export function defaultOidcDiscoveryUrl(issuer?: string): string | undefined {
  if (!issuer) return undefined
  const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer
  return `${base}/.well-known/openid-configuration`
}

export async function resolvePublicBase(scope: string | null): Promise<string | null> {
  try {
    const settings = await settingsService.get(scope ?? DEFAULT_TENANT_ID)
    if (settings?.domain) return `https://${settings.domain}`
  } catch {
    // Settings injoignables → fallback ci-dessous, jamais de throw.
  }
  const publicHost = process.env.PUBLIC_HOST
  if (publicHost) return `https://${publicHost}`
  if (!isProdLike()) return `http://localhost:${process.env.API_PORT ?? "4000"}`
  return null
}

export interface AutoManagedFields {
  redirectUri?: string
  discoveryUrl?: string
  spIssuer?: string
  callbackUrl?: string
}

/**
 * Calcule les champs autogérés absents de la config. Le préfixe `config.`
 * (valeur fournie par l'utilisateur) est toujours respecté (override expert).
 */
export async function autoManagedFields(
  kind: string,
  providerId: string,
  scope: string | null,
  config: Record<string, unknown>,
): Promise<AutoManagedFields> {
  const out: AutoManagedFields = {}
  // Kinds sans champs autogérés (LDAP…) : aucun accès à la base publique.
  if (kind !== "oidc" && kind !== "oauth2" && kind !== "saml") return out
  const base = await resolvePublicBase(scope)
  if (!base) return out

  if (kind === "oidc" || kind === "oauth2") {
    if (!config.redirectUri) out.redirectUri = `${base}/api/auth/sso/${providerId}/callback`
  }
  if (kind === "oidc") {
    if (!config.discoveryUrl) out.discoveryUrl = defaultOidcDiscoveryUrl(typeof config.issuer === "string" ? config.issuer : undefined)
  }
  if (kind === "saml") {
    if (!config.spIssuer) out.spIssuer = `${base}/api/auth/saml/${providerId}/metadata`
    if (!config.callbackUrl) out.callbackUrl = `${base}/api/auth/saml/${providerId}/acs`
  }
  return out
}