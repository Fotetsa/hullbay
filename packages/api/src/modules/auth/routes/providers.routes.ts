/**
 * Routes d'administration des providers d'authentification (owner uniquement).
 * AuthProvider = source de vérité.
 *
 * SÉCURITÉ :
 * - jamais de secret renvoyé : la liste masque les champs sensibles (marqueur
 *   de présence, pas la valeur) ;
 * - à l'écriture, les champs sensibles sont chiffrés individuellement
 *   (encryptObject, scope "provider") avant stockage en base ;
 * - le marqueur "••••••••" envoyé en PUT sur un champ sensible signifie
 *   "conserver la valeur actuelle" (jamais d'écrasement par un placeholder) ;
 * - schema zod par kind (whitelist stricte : toute clé inconnue rejetée) ;
 * - anti-énumération : id inconnu → 404 uniforme ;
 * - isolation tenant : le tenant d'une mutation est TOUJOURS dérivé du
 *   contexte authentifié (reqTenant), jamais d'un champ tenantId du body
 *   (présence → 400 tenant_id_not_allowed). La portée du provider est
 *   immuable après création. La CRÉATION n'est possible que depuis le tenant
 *   défaut (registry SSO partagé ne résout que les providers globaux/défaut)
 *   et produit un provider GLOBAL (tenantId null) ; un autre tenant reçoit
 *   400 tenant_providers_not_supported au lieu d'un provider fantôme ;
 * - anti-lockout résolu selon la portée du provider (jamais globale) :
 *   tenant-scoped → autres providers actifs du MÊME tenant ; global →
 *   autres providers actifs globaux. Count + mutation dans la MÊME
 *   transaction, sérialisées par un advisory lock de portée Postgres
 *   (lockProviderScope) : deux mutateurs concurrents ne peuvent plus
 *   désactiver/supprimer « le dernier provider » en se basant sur un count
 *   périmé (anti-TOCTOU).
 *
 * LIMITATION CONNUE (documentée) : les providers tenant-scoped d'un tenant
 * (hors tenant défaut) sont administrables ici mais ne sont jamais hydratés
 * par le ProviderRegistry de runtime (qui n'expose que globaux + tenant
 * défaut) — un provider tenant-scoped hors défaut n'est donc jamais utilisé
 * par le SSO tant que le registre n'est pas tenant-aware (voir registry/).
 *
 * Chaque mutation re-hydrate le ProviderRegistry depuis la DB (loadFromDb).
 */

import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { requireRole } from "../authorization/rbac"
import { prisma } from "../../../lib/prisma"
import { eventBus } from "../../../lib/event-bus"
import { X509Certificate } from "node:crypto"
import { encryptObject, encryptProviderSecret, decryptObject } from "../secrets/secret-encryption-service"
import { autoManagedFields, defaultOidcDiscoveryUrl } from "../providers/provider-auto-config"
import { SENSITIVE_FIELDS_BY_KIND } from "../registry/seeds"
import { providerRegistry } from "../registry/provider-registry"
import { AuthError, type ProviderKind } from "../providers/types"
import { DEFAULT_TENANT_ID } from "../identity/auth-identity.service"
import type { TenantScopedRequest } from "../tenancy/tenant-resolver"
import { settingsService } from "../../settings/service"

const owner = { preHandler: requireRole("owner") }

/** Tenant effectif de la requête (claim session → défaut). */
function reqTenant(req: FastifyRequest): string {
  return (req as TenantScopedRequest).tenantId ?? DEFAULT_TENANT_ID
}

/** Marqueur renvoyé à la place d'un secret (présence, jamais la valeur). */
const SECRET_MASK = "••••••••"

// Protocoles dont le flux repose sur un domaine public (callback/redirect).
// LDAP et local sont exclus : utilisables sans domaine public.
const DOMAIN_DEPENDENT_PROTOCOLS = new Set(["oidc", "oauth2", "saml"])

function isProdLike(): boolean {
  const env = process.env.NODE_ENV
  return env !== "development" && env !== "test"
}

/**
 * Garde-fou : un provider dépendant d'un domaine public ne peut pas être
 * ACTIF en production sans domaine public configuré pour sa portée.
 *
 * Portée réelle du provider (jamais le tenant de la requête) :
 * - tenant-scoped (tenantId non null) → domaine du Settings de CE tenant ;
 * - global (tenantId null) → portée installation = domaine du tenant défaut
 *   (les providers globaux ne sont mutables que depuis DEFAULT_TENANT_ID).
 */
async function assertDomainConfigured(kind: string, finalEnabled: boolean, scope: string | null) {
  if (!isProdLike() || !finalEnabled || !DOMAIN_DEPENDENT_PROTOCOLS.has(kind)) return
  const tenantId = scope ?? DEFAULT_TENANT_ID
  const settings = await settingsService.get(tenantId)
  if (!settings.domain) {
    throw new AuthError(
      "domain_not_configured",
      "activation du provider nécessite un domaine public configuré pour sa portée",
      400,
    )
  }
}

/**
 * Anti-lockout SCOPÉ : compte les providers actifs SUR LA MÊME PORTÉE que la
 * cible — jamais à l'échelle globale (un provider d'un autre tenant ne doit
 * pas empêcher/permettre la désactivation du dernier provider d'un tenant).
 *   - tenant-scoped (tenantId non null) → mêmes tenants uniquement ;
 *   - global (tenantId null) → les globaux uniquement.
 */
type ProviderCountDb = {
  authProvider: { count: (args: any) => Promise<number> }
}

async function activeProvidersCountExcept(
  id: string,
  scope: string | null,
  db: ProviderCountDb = prisma,
): Promise<number> {
  return db.authProvider.count({
    where: { id: { not: id }, enabled: true, tenantId: scope },
  })
}

/** Réponse d'erreur AuthError compacte (400 + code machine). */
function authErrorPayload(err: unknown) {
  if (err instanceof AuthError) {
    return { code: err.code, error: err.message }
  }
  return undefined
}

type LockTx = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>
}

/**
 * Sérialise les mutations d'une PORTÉE de providers (advisory lock Postgres,
 * scope transaction). Deux écrivains concurrents de la même portée attendent
 * tour à tour : le second relit le count APRÈS le commit du premier. Sans ce
 * lock, la transaction isolait bien count+mutation mais deux transactions
 * concurrentes pouvaient chacune voir « un autre provider actif » puis le
 * désactiver/supprimer toutes les deux → portée à zéro provider actif.
 *
 * $executeRaw (pas $queryRaw) : pg_advisory_xact_lock retourne void, que
 * Prisma refuse de désérialiser en SELECT (P2010 « deserialize column of type
 * void »).
 *
 * Clé : "hullbay:providers:" + "g:global" (portée globale, tenantId null) ou
 * "t:<tenantId>" — namespaces distincts, un tenant nommé "global" ne partage
 * jamais la clé de la portée globale ; les deux campagnes ne se bloquent pas.
 */
async function lockProviderScope(tx: LockTx, scope: string | null): Promise<void> {
  const key = scope === null ? "g:global" : `t:${scope}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hullbay:providers:' || ${key}, 0))`
}

/** Fetch borné (timeout 5 s par défaut) via AbortController. */
async function fetchWithTimeout(url: string, init?: RequestInit, ms = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe HTTP bornée (5 s) — ne lève jamais : ok/message pour le prévol.
 *
 * Politique egress / SSRF : route owner-only, cibles = URL de la config IdP
 * fournie par l'admin. Chaque saut (dont redirects, follow) est borné à 5 s ;
 * on suit les redirects volontairement (issuer http→https légitimes), et il
 * n'y a PAS de blocage des réseaux internes (metadata/cloud) à ce niveau.
 * Risque accepté, à durcir plus tard (SSRFTool/réseau interne) — documenté.
 */
async function probeHttp(url: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchWithTimeout(url, { redirect: "follow" })
    const result = { ok: res.ok, message: `HTTP ${res.status}` }
    // On n'utilise que le statut : libérer le body (socket/pool non retenus).
    await res.body?.cancel()
    return result
  } catch {
    return { ok: false, message: "injoignable (timeout 5s)" }
  }
}

/**
 * Lit un body texte avec un plafond d'octets : au-delà, cancel + throw.
 * Empêche un discovery énorme (IdP non fiable, route admin) d'épuiser la
 * mémoire de l'hôte.
 */
async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return res.text()
  const chunks: string[] = []
  const decoder = new TextDecoder()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error("body_too_large")
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  return chunks.join("")
}

function isPemCertificate(value: string): boolean {
  if (!/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.test(value)) return false
  try {
    new X509Certificate(value)
    return true
  } catch {
    return false
  }
}

const trimmedOptional = () => z.string().trim().min(1, "valeur vide ou espaces seuls interdits").optional()

const oidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().optional(),
  // redirectUri est dérivé (hullbay) si absent : callback du flux SSO.
  redirectUri: z.string().url().optional(),
  scopes: trimmedOptional(),
  // discoveryUrl dérivée depuis issuer si absente (issuer/.well-known...).
  discoveryUrl: z.string().url().optional(),
  jwksUri: z.string().url().optional(),
  acceptedClockSkewMs: z.number().int().positive().max(300000).optional(),
}).strict()

const oauth2ConfigSchema = z.object({
  authorizationUri: z.string().url(),
  tokenUri: z.string().url(),
  userinfoUri: z.string().url(),
  clientId: z.string().trim().min(1),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
  scopes: trimmedOptional(),
  groupAttr: trimmedOptional(),
}).strict()

const samlConfigSchema = z.object({
  // Certificat IdP obligatoirement un X.509 PEM valide (parse réel, pas une
  // simple regex) — un cert corrompu rendait le provider silencieusement mort.
  idpCert: z.string().trim().min(1).refine(isPemCertificate, "idpCert doit être un certificat X.509 PEM valide"),
  idpIssuer: z.string().trim().min(1),
  spIssuer: z.string().trim().min(1).optional(),
  entryPoint: z.string().url(),
  callbackUrl: z.string().url().optional(),
  audience: trimmedOptional(),
  acceptedClockSkewMs: z.number().int().positive().max(300000).optional(),
}).strict()

const ldapConfigSchema = z.object({
  url: z.string().trim().regex(/^ldaps?:\/\/.+/i, "url doit commencer par ldap:// ou ldaps://"),
  tlsOptions: z.object({
    rejectUnauthorized: z.boolean().optional(),
    ca: z.string().optional(),
  }).strict().optional(),
  bindDn: trimmedOptional(),
  bindSecret: z.string().trim().optional(),
  searchBase: z.string().trim().min(1),
  searchFilter: z.string().trim().min(1),
  groupSearchBase: trimmedOptional(),
  groupFilter: trimmedOptional(),
  stableAttr: z.string().trim().min(1),
  attrMap: z.object({
    username: trimmedOptional(),
    email: trimmedOptional(),
    name: trimmedOptional(),
    groups: trimmedOptional(),
  }).strict().optional(),
  timeoutMs: z.number().int().positive().max(60000).optional(),
  handleReferrals: z.boolean().optional(),
}).strict()

const CONFIG_SCHEMAS: Record<Exclude<ProviderKind, "local">, z.ZodType<Record<string, unknown>>> = {
  oidc: oidcConfigSchema,
  oauth2: oauth2ConfigSchema,
  saml: samlConfigSchema,
  ldap: ldapConfigSchema,
}

function kindToSchema(kind: string) {
  if (kind === "local") return null
  return CONFIG_SCHEMAS[kind as keyof typeof CONFIG_SCHEMAS] ?? null
}

function maskConfig(config: Record<string, unknown>, kind: string): Record<string, unknown> {
  const masked = { ...config }
  for (const field of SENSITIVE_FIELDS_BY_KIND[kind as ProviderKind] ?? []) {
    if (typeof masked[field] === "string") masked[field] = SECRET_MASK
  }
  return masked
}

function dto(row: {
  id: string
  kind: string
  name: string
  enabled: boolean
  tenantId?: string | null
  config?: unknown
}) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    // tenantId = null ⇒ provider global (disponible pour tous les tenants).
    tenantId: row.tenantId ?? null,
    config: maskConfig((row.config as Record<string, unknown>) ?? {}, row.kind),
  }
}

export async function registerProvidersRoutes(app: FastifyInstance) {
  // Liste (secrets masqués).
  app.get(
    "/api/auth/admin/providers",
    {
      ...owner,
      schema: {
        tags: ["auth"],
        summary: "Liste des providers d'authentification (owner) — secrets masqués",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      // Liste filtrée par tenant effectif — providers du tenant courant
      // + providers globaux (tenantId null). Jamais ceux d'un autre tenant.
      const tenantId = reqTenant(req)
      const rows = await prisma.authProvider.findMany({
        where: { OR: [{ tenantId }, { tenantId: null }] },
        orderBy: { kind: "asc" },
        select: { id: true, kind: true, name: true, enabled: true, config: true, tenantId: true },
      })
      return rows.map(dto)
    },
  )

  const createBody = z.object({
    id: z.string().regex(/^[a-z0-9-]{3,64}$/, "id : a-z0-9 et tirets (3-64)").optional(),
    kind: z.enum(["oidc", "oauth2", "saml", "ldap"]),
    name: z.string().min(1, "nom requis").max(120),
    enabled: z.boolean().default(false),
    config: z.record(z.string(), z.any()).default({}),
    // Déclaré UNIQUEMENT pour être rejeté : le validator Fastify
    // (type-provider-zod) retire les clés inconnues du body avant le handler —
    // cette clé déclarée survit à la validation, ce qui permet de lever
    // tenant_id_not_allowed. La retirer (ou .strict()) rendrait le tenantId
    // client silencieusement ignoré au lieu de rejeté : attention si modifié.
    tenantId: z.string().min(1).nullable().optional(),
  })

  // Création.
  app.post(
    "/api/auth/admin/providers",
    {
      ...owner,
      schema: {
        body: createBody,
        tags: ["auth"],
        summary: "Création d'un provider (owner) : config whitelist par kind, secrets chiffrés",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const body = createBody.parse(req.body)
      // Isolation tenant : la portée vient du contexte authentifié, JAMAIS du
      // body. Un tenantId envoyé (= B ou null) est refusé explicitement.
      if (body.tenantId !== undefined) {
        return reply.code(400).send({
          error: "tenant_id_not_allowed",
          message: "le tenant du provider est dérivé du contexte authentifié (non modifiable via le body)",
          code: "tenant_id_not_allowed",
        })
      }
      const schema = kindToSchema(body.kind)
      if (!schema) {
        return reply.code(400).send({ error: "unsupported_kind", message: `kind ${body.kind} n’est pas gérable via l’API`, code: "unsupported_kind" })
      }
      const parsed = schema.safeParse(body.config)
      if (!parsed.success) {
        const details = parsed.error.flatten().fieldErrors
        return reply.code(400).send({ error: "invalid_config", message: "configuration invalide", code: "invalid_config", details })
      }
      // OAuth2 confidentiel : le provider envoie toujours client_secret au token
      // endpoint (oauth2-provider.ts). Accepté optionnel, un provider créé sans
      // secret était silencieusement inutilisable (invalid_client_credentials).
      if (body.kind === "oauth2" && !parsed.data.clientSecret) {
        return reply.code(400).send({
          error: "invalid_config",
          message: "OAuth2 : clientSecret requis à la création (flux confidentiel)",
          code: "invalid_config",
          details: { clientSecret: ["requis — le token endpoint exige client_secret (flux confidentiel)"] },
        })
      }
      const config = encryptObject(parsed.data, SENSITIVE_FIELDS_BY_KIND[body.kind])
      // Isolation tenant : le registre SSO partagé ne résout que les providers
      // globaux (tenantId null) et ceux du tenant défaut (loadFromDb). Un
      // provider créé pour un autre tenant serait un fantôme : 201 en base,
      // 404 à chaque login SSO. La création est donc réservée au tenant défaut
      // et produit toujours un provider GLOBAL.
      const scope = reqTenant(req)
      if (scope !== DEFAULT_TENANT_ID) {
        return reply.code(400).send({
          error: "tenant_providers_not_supported",
          message: "la création de providers n'est possible que depuis le tenant défaut (provider global)",
          code: "tenant_providers_not_supported",
        })
      }
      try {
        // Garde-fou : contrôle AVANT persistance sur la portée cible (global).
        await assertDomainConfigured(body.kind, body.enabled, null)
        let row = await prisma.authProvider.create({
          data: {
            kind: body.kind,
            name: body.name,
            enabled: body.enabled,
            config: config as never,
            tenantId: null,
            ...(body.id ? { id: body.id } : {}),
          },
        })
        // Champs gérés par Hullbay (redirect/callback/discovery/spIssuer) :
        // posés en base quand absents, résolus depuis le domaine public.
        const auto = await autoManagedFields(body.kind, row.id, null, parsed.data)
        if (Object.keys(auto).length > 0) {
          const withAuto = { ...parsed.data, ...auto }
          const autoConfig = encryptObject(withAuto, SENSITIVE_FIELDS_BY_KIND[body.kind])
          row = await prisma.authProvider.update({ where: { id: row.id }, data: { config: autoConfig as never } })
        }
        await providerRegistry.loadFromDb()
        await eventBus.emit("auth.provider.created", { providerId: row.id, kind: row.kind })
        return reply.code(201).send(dto(row))
      } catch (err) {
        const payload = authErrorPayload(err)
        if (payload) return reply.code(err instanceof AuthError ? err.status : 400).send(payload)
        if (err instanceof Error && /unique/i.test(err.message) && body.id) {
          return reply.code(409).send({ error: "provider_conflict", message: "un provider porte déjà cet id", code: "provider_conflict" })
        }
        throw err
      }
    },
  )

  const updateBody = z.object({
    name: z.string().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.any()).optional(),
    // Déclaré UNIQUEMENT pour être rejeté (re-scope interdit), voir createBody.
    tenantId: z.string().min(1).nullable().optional(),
  })

  // Mise à jour (partielle). Secrets : le marqueur conserve la valeur existante.
  app.put(
    "/api/auth/admin/providers/:id",
    {
      ...owner,
      schema: {
        body: updateBody,
        tags: ["auth"],
        summary: "Mise à jour d'un provider (owner) — secrets conservés si marqueur envoyé",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = updateBody.parse(req.body)
      // Isolation tenant : le tenant n'est PAS modifiable (re-scope = opération
      // admin dédiée, inexistante). Présence de tenantId → rejet explicite.
      if (body.tenantId !== undefined) {
        return reply.code(400).send({
          error: "tenant_id_not_allowed",
          message: "le tenant du provider n'est pas modifiable (dérivé du contexte authentifié)",
          code: "tenant_id_not_allowed",
        })
      }
      const row = await prisma.authProvider.findUnique({ where: { id } })
      if (!row) return reply.code(404).send({ error: "provider_not_found", message: "provider introuvable", code: "provider_not_found" })

      // Isolation tenant : un tenant ne voit ni ne modifie les providers
      // d'un autre tenant. Les providers globaux (tenantId null) ne sont
      // mutables que depuis le tenant défaut.
      const tenantId = reqTenant(req)
      const notOwned =
        (row.tenantId !== null && row.tenantId !== tenantId) ||
        (row.tenantId === null && tenantId !== DEFAULT_TENANT_ID)
      if (notOwned) {
        return reply.code(404).send({ error: "provider_not_found", message: "provider introuvable", code: "provider_not_found" })
      }

// Garde-fou : état FINAL (PUT partiel) + portée réelle du provider.
      // Ne pas tester uniquement body.enabled — un PUT partiel ne doit jamais
      // conserver/atteindre un état invalide. Portée = tenantId du provider
      // (immuable ici) — jamais un re-scope.
      const finalEnabled = body.enabled !== undefined ? body.enabled : row.enabled
      const scope = row.tenantId
      try {
        await assertDomainConfigured(row.kind, finalEnabled, scope)
      } catch (err) {
        return reply.code(err instanceof AuthError ? err.status : 400).send(authErrorPayload(err))
      }

      const schema = kindToSchema(row.kind)
      const currentConfig = (row.config as Record<string, unknown>) ?? {}
      let encryptedConfig = currentConfig
      // Delta fourni (config live du PUT) — null si la requête n'en porte pas.
      let parsedData: Record<string, unknown> | null = null
      if (body.config !== undefined) {
        if (!schema) {
          return reply.code(400).send({ error: "unsupported_kind", message: `kind ${row.kind} n’est pas gérable via l’API`, code: "unsupported_kind" })
        }
        const parsed = schema.safeParse(body.config)
        if (!parsed.success) {
          const details = parsed.error.flatten().fieldErrors
          return reply.code(400).send({ error: "invalid_config", message: "configuration invalide", code: "invalid_config", details })
        }
        parsedData = parsed.data
        // Fusionne avec la config existante. Le marqueur sentinelle signifie
        // "conserver la valeur actuelle" : les champs sensibles déjà chiffrés
        // en base restent intacts (pas de double-chiffrement — decryptObject
        // doit retrouver le secret en clair). Seul le delta fourni est
        // chiffré ; les champs sensibles non fournis gardent leur blob stocké.
        const sensitive = SENSITIVE_FIELDS_BY_KIND[row.kind as ProviderKind] ?? []
        const merged: Record<string, unknown> = { ...currentConfig }
        for (const [key, value] of Object.entries(parsed.data)) {
          if (value === SECRET_MASK) continue
          merged[key] = sensitive.includes(key) ? encryptProviderSecret(value as string) : value
        }
        // Champs gérés par Hullbay résolus depuis le domaine public (override
        // utilisateur toujours respecté : `??=`).
        const auto = await autoManagedFields(row.kind, id, scope, merged)
        Object.assign(merged, auto)
        encryptedConfig = merged
      }

      // Garde-fou §gestion : un provider ne peut PAS être activé si sa config
      // EFFECTIVE (config stockée déchiffrée + delta fourni) est invalide.
      // "••••••••" sur un secret = conserver le stocké (jamais un placeholder).
      // Sans ce garde-fou, un toggle activait un provider mort en production.
      if (finalEnabled && row.kind !== "local" && schema) {
        const sensitive = SENSITIVE_FIELDS_BY_KIND[row.kind as ProviderKind] ?? []
        const cleanProvided =
          body.config === undefined ? {} : Object.fromEntries(Object.entries(parsedData ?? {}).filter(([, v]) => v !== SECRET_MASK))
        // Blob secret illisible (clé tournée entre-temps…) → refuse d'activer :
        // on préfère fermer que d'activer un provider dont on ne peut vérifier
        // la config effective.
        let effective: Record<string, unknown>
        try {
          effective = { ...decryptObject(currentConfig, sensitive), ...cleanProvided }
        } catch {
          return reply.code(400).send({
            error: "invalid_config",
            message: "activation refusée : secret stocké illisible (clé de chiffrement probablement changée)",
            code: "invalid_config",
          })
        }
        const gate = schema.safeParse(effective)
        if (!gate.success) {
          return reply.code(400).send({
            error: "invalid_config",
            message: "activation refusée : configuration incomplète ou invalide",
            code: "invalid_config",
            details: gate.error.flatten().fieldErrors,
          })
        }
        if (row.kind === "oauth2" && !effective.clientSecret) {
          return reply.code(400).send({
            error: "invalid_config",
            message: "OAuth2 : clientSecret requis pour activer (flux confidentiel)",
            code: "invalid_config",
            details: { clientSecret: ["requis — le token endpoint exige client_secret (flux confidentiel)"] },
          })
        }
      }

      // Garde anti-lockout scoped : on ne peut jamais désactiver le dernier
      // provider actif DE LA PORTÉE (les providers d'autres tenants ne
      // comptent pas, pas plus que les globaux pour une portée tenant).
      // Count + update dans la MÊME transaction, précédés d'un lock de portée
      // (advisory) qui sérialise deux mutateurs concurrents : le second relit
      // le count APRÈS le commit du premier → pas de TOCTOU, les deux ne
      // peuvent plus croire qu'un autre provider reste actif. L'état enabled
      // est relu dans la transaction (jamais le row hors-tx, périmable).
      const updateData = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.config !== undefined ? { config: encryptedConfig as never } : {}),
      }
      let updated
      try {
        updated = await prisma.$transaction(async (tx) => {
          if (body.enabled === false) {
            // Re-lecture de enabled DANS la transaction, après le lock : un
            // PUT concurrent a pu l'activer entre le findUnique et ici (le
            // row.enabled hors-tx serait périmé). Le lock de portée n'est pris
            // que sur ce chemin (désactivation) — un rename/config n'attend pas.
            const fresh = await tx.authProvider.findUnique({ where: { id }, select: { enabled: true } })
            if (fresh?.enabled) {
              await lockProviderScope(tx, scope)
              const otherEnabled = await activeProvidersCountExcept(id, scope, tx)
              if (otherEnabled === 0) {
                throw new AuthError("cannot_disable_last_provider", "au moins un provider doit rester actif", 400)
              }
            }
          }
          return tx.authProvider.update({ where: { id }, data: updateData })
        })
      } catch (err) {
        const payload = authErrorPayload(err)
        if (payload) return reply.code(err instanceof AuthError ? err.status : 400).send(payload)
        throw err
      }
      await providerRegistry.loadFromDb()
      await eventBus.emit("auth.provider.updated", { providerId: updated.id, kind: updated.kind })
      return dto(updated)
    },
  )

  // Suppression — refus si des identités existent déjà (on n'orpheline jamais).
  app.delete(
    "/api/auth/admin/providers/:id",
    {
      ...owner,
      schema: {
        tags: ["auth"],
        summary: "Suppression d'un provider (owner) — refus si des identités existent",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const row = await prisma.authProvider.findUnique({ where: { id }, select: { id: true, kind: true, enabled: true, tenantId: true } })
      if (!row) return reply.code(404).send({ error: "provider_not_found", message: "provider introuvable", code: "provider_not_found" })
      const tenantId = reqTenant(req)
      const notOwned =
        (row.tenantId !== null && row.tenantId !== tenantId) ||
        (row.tenantId === null && tenantId !== DEFAULT_TENANT_ID)
      if (notOwned) {
        return reply.code(404).send({ error: "provider_not_found", message: "provider introuvable", code: "provider_not_found" })
      }
      if (row.id === "local") {
        return reply.code(400).send({ error: "cannot_delete_local_provider", message: "le provider local ne peut pas être supprimé", code: "cannot_delete_local_provider" })
      }
      // Suppression atomique : lock de portée (advisory) + garde anti-lockout
      // scoped + comptes d'identités et pendings + delete dans la MÊME
      // transaction — pas de TOCTOU (2 suppressions concurrentes du dernier
      // provider ne peuvent plus passer : l'une attend le commit de l'autre).
      try {
        await prisma.$transaction(async (tx) => {
          await lockProviderScope(tx, row.tenantId)
          // enabled relu dans la transaction (row hors-tx périmable) : le
          // lock sérialise les concurrents, le fresh read décide la garde.
          const fresh = await tx.authProvider.findUnique({ where: { id }, select: { enabled: true } })
          if (fresh?.enabled) {
            const otherEnabled = await activeProvidersCountExcept(id, row.tenantId, tx)
            if (otherEnabled === 0) {
              throw new AuthError("cannot_delete_last_provider", "au moins un provider doit rester actif", 400)
            }
          }
          const identities = await tx.authIdentity.count({ where: { providerId: id } })
          if (identities > 0) {
            throw new AuthError("provider_in_use", `provider utilisé par ${identities} identité(s)`, 409)
          }
          const pendings = await tx.pendingIdentity.count({ where: { providerId: id } })
          if (pendings > 0) {
            throw new AuthError("provider_pendings_exist", "des approbations en attente référencent ce provider", 409)
          }
          await tx.authProvider.delete({ where: { id } })
        })
      } catch (err) {
        const payload = authErrorPayload(err)
        if (payload) return reply.code(err instanceof AuthError ? err.status : 400).send(payload)
        throw err
      }
      await providerRegistry.loadFromDb()
      await eventBus.emit("auth.provider.deleted", { providerId: id })
      return reply.code(204).send()
    },
  )

  // Test de connexion (validation config + joignabilité si possible).
  app.post(
    "/api/auth/admin/providers/:id/test",
    {
      ...owner,
      schema: {
        tags: ["auth"],
        summary: "Test de configuration d'un provider (owner) — sans secret renvoyé",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const row = await prisma.authProvider.findUnique({ where: { id }, select: { id: true, kind: true, config: true, enabled: true, name: true, tenantId: true } })
      if (!row) return reply.code(404).send({ error: "provider_not_found", message: "provider introuvable", code: "provider_not_found" })
      const tenantId = reqTenant(req)
      const notOwned =
        (row.tenantId !== null && row.tenantId !== tenantId) ||
        (row.tenantId === null && tenantId !== DEFAULT_TENANT_ID)
      if (notOwned) {
        return reply.code(404).send({ error: "provider_not_found", message: "provider introuvable", code: "provider_not_found" })
      }

      const schema = kindToSchema(row.kind)
      if (!schema) {
        return reply.code(400).send({ error: "untestable_kind", message: `kind ${row.kind} n’est pas testable via l’API`, code: "untestable_kind" })
      }
      const current = (row.config as Record<string, unknown>) ?? {}
      const config = schema.safeParse(maskConfig(current, row.kind))
      if (!config.success) {
        return reply.code(200).send({
          ok: false,
          error: "invalid_config",
          message: "configuration incomplète ou invalide",
          code: "invalid_config",
          details: config.error.flatten().fieldErrors,
        })
      }
      try {
        // Tente la joignabilité OIDC (discovery) si renseignée ou dérivable
        // depuis issuer — annulé après 5 s.
        let connectivity: string | null = null
        const discoveryUrl =
          typeof current.discoveryUrl === "string"
            ? current.discoveryUrl
            : defaultOidcDiscoveryUrl(typeof current.issuer === "string" ? current.issuer : undefined)
        if (row.kind === "oidc" && discoveryUrl) {
          const probe = await probeHttp(discoveryUrl)
          connectivity = probe.ok ? `discovery joignable (${probe.message})` : `discovery ${probe.message}`
        } else if (row.kind === "ldap") {
          const { createLdapProvider } = await import("../providers/ldap/ldap-provider")
          // La config stockée est chiffrée : on la déchiffre avant de construire
          // l'adapter (lui ne déchiffre plus, cf. double-déchiffrement).
          const decrypted = decryptObject(current, SENSITIVE_FIELDS_BY_KIND["ldap"] ?? [])
          const ldapProvider = createLdapProvider({ ...(decrypted as Record<string, unknown> as any), id: row.id })
          const testRes = await ldapProvider.testConnection()
          return {
            ok: testRes.ok,
            message: testRes.message,
            connectivity: testRes.ok ? "LDAP joignable" : "LDAP injoignable",
          }
        }
        return {
          ok: true,
          message: connectivity ?? "configuration valide",
          connectivity,
        }
      } catch (err) {
        return reply.code(200).send({
          ok: false,
          error: "serveur LDAP injoignable",
          message: (err as Error)?.message || "serveur LDAP injoignable",
          code: "ldap_unreachable",
        })
      }
    },
  )

  // Prévol (wizard) : valide une config À L'ÉCRAN, sans persister, et sonde la
  // joignabilité de chaque endpoint côté IdP. Ne renvoie jamais de secret.
  app.post(
    "/api/auth/admin/providers/preflight",
    {
      ...owner,
      schema: {
        body: z.object({
          kind: z.enum(["oidc", "oauth2", "saml", "ldap"]),
          config: z.record(z.string(), z.any()).default({}),
        }),
        tags: ["auth"],
        summary: "Prévol de config provider (owner) : validation + joignabilité étape par étape",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req) => {
      const body = z.object({ kind: z.enum(["oidc", "oauth2", "saml", "ldap"]), config: z.record(z.string(), z.any()).default({}) }).parse(req.body)
      const schema = CONFIG_SCHEMAS[body.kind]
      const check = schema.safeParse(body.config)
      if (!check.success) {
        return {
          ok: false,
          schemaValid: false,
          steps: [],
          details: check.error.flatten().fieldErrors,
        }
      }
      const cfg = check.data as Record<string, unknown>
      const steps: { step: string; ok: boolean; message: string; latencyMs?: number }[] = []

      if (body.kind === "oidc") {
        const discoveryUrl =
          typeof cfg.discoveryUrl === "string"
            ? cfg.discoveryUrl
            : defaultOidcDiscoveryUrl(typeof cfg.issuer === "string" ? cfg.issuer : undefined)
        if (discoveryUrl) {
          const t0 = Date.now()
          const probe = await probeHttp(discoveryUrl)
          let message = probe.ok ? `discovery joignable (${probe.message})` : `discovery ${probe.message}`
          if (probe.ok) {
            try {
              const jsonRes = await fetchWithTimeout(discoveryUrl, { redirect: "follow" })
              const text = await readBoundedText(jsonRes, 262144)
              const doc = JSON.parse(text) as { issuer?: string }
              if (doc.issuer && doc.issuer !== cfg.issuer) message += " — issuer ne correspond pas au discovery"
            } catch {
              message += " — réponse non-JSON ou trop volumineuse"
            }
          }
          steps.push({ step: "discovery", ok: probe.ok, message, latencyMs: Date.now() - t0 })
        }
      } else if (body.kind === "oauth2") {
        for (const [step, url] of [
          ["authorization_uri", cfg.authorizationUri],
          ["token_uri", cfg.tokenUri],
        ] as const) {
          if (typeof url !== "string") continue
          const label = step === "authorization_uri" ? "authorizationUri" : "tokenUri"
          const t0 = Date.now()
          const probe = await probeHttp(url)
          const message = probe.ok ? `${label} joignable (${probe.message})` : `${label} ${probe.message}`
          steps.push({ step, ok: probe.ok, message, latencyMs: Date.now() - t0 })
        }
      } else if (body.kind === "saml") {
        if (typeof cfg.entryPoint === "string") {
          const t0 = Date.now()
          const probe = await probeHttp(cfg.entryPoint)
          steps.push({ step: "entry_point", ok: probe.ok, message: probe.ok ? `entryPoint joignable (${probe.message})` : `entryPoint ${probe.message}`, latencyMs: Date.now() - t0 })
        }
      } else if (body.kind === "ldap") {
        const { createLdapProvider } = await import("../providers/ldap/ldap-provider")
        const t0 = Date.now()
        const ldapProvider = createLdapProvider({ ...(cfg as Record<string, unknown> as any), id: "preflight" })
        const bindRes = await ldapProvider.testConnection()
        steps.push({ step: "bind", ok: bindRes.ok, message: bindRes.ok ? "bind LDAP réussi" : "bind LDAP échoué", latencyMs: Date.now() - t0 })
      }

      return {
        ok: steps.length === 0 ? true : steps.every((s) => s.ok),
        schemaValid: true,
        steps,
      }
    },
  )
}