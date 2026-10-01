/**
 * Contrats partagés entre tous les providers et le cœur auth.
 * Aucune dépendance Fastify ici : les callbacks reçoivent des types génériques
 * (FastifyRequest/FastifyReply au niveau impl).
 */

export type ProviderKind = "local" | "oidc" | "oauth2" | "saml" | "ldap"

export interface ExternalIdentity {
  providerId: string
  kind: ProviderKind
  issuer: string | null      // NULL pour local / ldap-bind
  subject: string            // identifiant stable : local:<id> / iss+sub / objectGUID…
  email?: string | null
  /** Vrai uniquement si l'IdP affirme l'email vérifié (OIDC `email_verified`,
   *  SSO-callback d'entrée). LDAP/OAuth2 = undefined → assimilé false.
   *  GARDE : un User existant n'est réutilisé qu'avec un email vérifié. */
  emailVerified?: boolean
  name?: string
  groups?: string[]
}

export interface AuthInput {
  kind: ProviderKind
  email?: string
  password?: string
  code?: string
  redirectUri?: string
  codeVerifier?: string
  samlResponse?: string
  relayState?: string
  ldapUsername?: string
  ldapPassword?: string
}

export interface AuthResult {
  identity: ExternalIdentity
  mfaRequired: boolean
  mfaPendingToken?: string
  // Résolution vers un User enregistré (POST mapping) : chaque provider doit
  // exposer le userId + rôle effectif pour le signing de session.
  userId: string
  role: string
}

export interface ProviderPublicConfig {
  id: string
  kind: ProviderKind
  name: string
  enabled: boolean
}

export interface AuthProviderContract {
  id: string
  kind: ProviderKind
  enabled: boolean
  authenticate(input: AuthInput): Promise<AuthResult>
  initiateLogin?(req: unknown, reply: unknown): Promise<void>
  callback?(req: unknown, raw: unknown): Promise<ExternalIdentity>
  logout?(req: unknown): Promise<void>
  getConfig(): ProviderPublicConfig
}

// ── Erreurs d'authentification partagées ──

export type AuthErrorCode =
  | "invalid_credentials"
  | "mfa_token_invalid"
  | "mfa_code_invalid"
  | "mfa_not_configured"
  | "webauthn_not_configured"
  | "webauthn_origin_forbidden"
  | "webauthn_origin_invalid"
  | "webauthn_rpid_invalid"
  | "domain_not_configured"
  | "mfa_enrollment_missing"
  | "mfa_not_enabled"
  | "password_incorrect"
  | "identity_pending_approval"
  | "session_revoked"
  | "session_invalid"
  // Admin API providers (routes/providers.routes.ts) — codes levés dans les
  // transactions d'écriture, convertis en réponse par le handler.
  | "cannot_disable_last_provider"
  | "cannot_delete_last_provider"
  | "provider_in_use"
  | "provider_pendings_exist"

export class AuthError extends Error {
  code: AuthErrorCode
  status: number
  /** UserId résolu quand un échec concerne un compte existant (audit corrélé). */
  userId?: string
  /** Cause machine d'un échec (ex. "account_disabled_or_locked"). Jamais
   *  sérialisée vers le client : sert uniquement à l'audit. */
  reason?: string

  constructor(code: AuthErrorCode, message: string, status = 400, reason?: string) {
    super(message)
    this.name = "AuthError"
    this.code = code
    this.status = status
    this.reason = reason
  }
}
