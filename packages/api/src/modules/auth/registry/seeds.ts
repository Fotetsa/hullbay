/**
 * Seeds du Provider Registry : configurations de base.
 * Aucun fournisseur commercial privilégié — local est un provider comme les autres.
 * Premier install = local UNIQUEMENT : plus aucun provider factice (config vide,
 * "timeout" à 100 ms) pré-créé dans la liste.
 *
 * Test IdP (Keycloak) : JAMAIS un défaut. Il n'est enregistré QUE si les
 * variables d'env de test sont présentes (e2e/CI) — une simple configuration,
 * pas un pilier du modèle.
 */

import type { ProviderKind } from "../providers/types"
import type { ProviderConfig } from "../providers/protocol-adapter"

export interface ProviderSeed {
  id: string
  kind: ProviderKind
  name: string
  enabled: boolean
  /** Configuration du protocole (uniquement pour les providers actifs). */
  config?: ProviderConfig
}

/**
 * Champs sensibles chiffrés individuellement dans AuthProvider.config.
 * Par kind : oidc/oauth2 → clientSecret ; SAML → aucun secret (idpCert public).
 * La clé privée SP SAML (signature AuthnRequest), si ajoutée, sera chiffrée ici →
 * scope "provider" (rotation de clés).
 */
export const SENSITIVE_FIELDS_BY_KIND: Record<ProviderKind, string[]> = {
  local: [],
  oidc: ["clientSecret"],
  oauth2: ["clientSecret"],
  saml: [],
  ldap: ["bindSecret"],
}

/**
 * Seeds "preset" historiques (config vide, désactivées) — remplacées par local
 * seul. Une row configurée (preset paramétré par l'utilisateur dans une
 * ancienne version) est CONSERVÉE : on ne détruit jamais une config manuelle.
 */
export const SUPERSEDED_GENERIC_IDS = ["oidc-generic", "oauth2-generic", "saml-generic", "ldap-generic"]

export const PROVIDER_SEEDS: ProviderSeed[] = [
  { id: "local", kind: "local", name: "Local", enabled: true },
]

/**
 * Provider OIDC "test" (Keycloak en e2e/CI). Actif uniquement si OIDC_TEST_*
 * renseignées — jamais par défaut, jamais en prod sans config explicite.
 */
export function loadTestOidcSeed(): ProviderSeed | null {
  const issuer = process.env.OIDC_TEST_ISSUER
  const clientId = process.env.OIDC_TEST_CLIENT_ID
  if (!issuer || !clientId) return null

  const enabled = process.env.OIDC_TEST_ENABLED === "true"
  const port = process.env.OIDC_TEST_PORT ?? "8080"
  const base = new URL(issuer.startsWith("http") ? issuer : `http://localhost:${port}/realms/hullbay`)

  return {
    id: "oidc-test",
    kind: "oidc",
    name: "Keycloak (test)",
    enabled,
    config: {
      issuer: base.toString().replace(/\/$/, ""),
      discoveryUrl: `${base.toString().replace(/\/$/, "")}/.well-known/openid-configuration`,
      clientId,
      clientSecret: process.env.OIDC_TEST_CLIENT_SECRET,
      redirectUri:
        process.env.OIDC_TEST_REDIRECT_URI ??
        `http://localhost:${process.env.API_PORT ?? "4000"}/api/auth/sso/oidc-test/callback`,
      scopes: "openid profile email",
    } as ProviderConfig,
  }
}

/**
 * Provider SAML "test" (Keycloak en e2e/CI). Actif uniquement si SAML_TEST_*
 * renseignées — jamais par défaut. Permet de dérouler le flux SAML complet
 * (login → ACS) contre un IdP de test provisionné par keycloak-saml.e2e.mjs.
 */
export function loadTestSamlSeed(): ProviderSeed | null {
  const idpIssuer = process.env.SAML_TEST_IDP_ISSUER
  const idpCert = process.env.SAML_TEST_IDP_CERT
  const spIssuer = process.env.SAML_TEST_SP_ENTITY
  if (!idpIssuer || !idpCert || !spIssuer) return null

  const enabled = process.env.SAML_TEST_ENABLED === "true"
  const port = process.env.SAML_TEST_IDP_PORT ?? "8081"
  const base = idpIssuer.startsWith("http") ? idpIssuer : `http://localhost:${port}/realms/hullbay`
  const apiPort = process.env.API_PORT ?? "4000"

  return {
    id: "saml-e2e",
    kind: "saml",
    name: "Keycloak SAML (test)",
    enabled,
    config: {
      idpIssuer: base,
      idpCert,
      spIssuer,
      entryPoint: `${base.replace(/\/$/, "")}/protocol/saml/clients/hullbay-saml-e2e`,
      callbackUrl: `http://localhost:${apiPort}/api/auth/saml/saml-e2e/acs`,
    } as ProviderConfig,
  }
}

export const DEFAULT_TENANT = { name: "Default", slug: "default" } as const