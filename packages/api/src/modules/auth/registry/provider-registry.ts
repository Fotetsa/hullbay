/**
 * Provider Registry : registre central des providers configurés.
 * Source de vérité : AuthProvider (registre hydraté au boot depuis la DB via
 * loadFromDb, sync seeds → DB dans provider-db.ts).
 */

import { createProvider } from "../providers/protocol-adapter"
import type { AuthProviderContract, ProviderKind } from "../providers/types"
import { PROVIDER_SEEDS, loadTestOidcSeed, loadTestSamlSeed } from "./seeds"
import { loadProviderRows } from "./provider-db"
import { DEFAULT_TENANT_ID } from "../identity/auth-identity.service"

/** Kinds pour lesquels un adapter existe (createProvider ne throw pas). */
export const SUPPORTED_KINDS: ProviderKind[] = ["local", "oidc", "oauth2", "saml", "ldap"]

export class ProviderRegistry {
  private providers = new Map<string, AuthProviderContract>()

  /** Enregistre un provider (écrase si même id). */
  register(provider: AuthProviderContract): void {
    this.providers.set(provider.id, provider)
  }

  /** Enregistre les presets activés depuis les seeds. */
  registerSeeds(): void {
    for (const seed of PROVIDER_SEEDS) {
      if (seed.enabled) {
        this.register(createProvider(seed.kind, seed.id, seed.config))
      }
    }
    // Test IdP (Keycloak e2e OIDC/SAML) : uniquement si config d'env explicite (jamais défaut).
    for (const seed of [loadTestOidcSeed(), loadTestSamlSeed()]) {
      if (seed?.enabled) {
        this.register(createProvider(seed.kind, seed.id, seed.config))
      }
    }
  }

  /** Récupère un provider par id. Renvoie undefined si absent. */
  get(id: string): AuthProviderContract | undefined {
    return this.providers.get(id)
  }

  /** Récupère un provider par id, lève si absent. */
  require(id: string): AuthProviderContract {
    const p = this.providers.get(id)
    if (!p) throw new Error(`provider ${id} introuvable ou désactivé`)
    return p
  }

  /** Liste tous les providers enregistrés. */
  list(): AuthProviderContract[] {
    return [...this.providers.values()]
  }

  /** Supprime tous les providers (utile pour les tests). */
  clear(): void {
    this.providers.clear()
  }

  /**
   * Hydrate le registre depuis AuthProvider : lit les rows, déchiffre
   * les champs sensibles par kind, injecte `enabled` (présent dans les options
   * des adapters mais pas dans la config stockée), puis (re)crée les adapters.
   * Nécessite une DB joignable — appelée au boot (skipSideEffects=false) et
   * après chaque mutation CRUD.
   */
  async loadFromDb(): Promise<void> {
    const rows = await loadProviderRows()
    const next = new Map<string, AuthProviderContract>()
    for (const row of rows) {
      // Le registre n'expose que les providers globaux (tenantId null,
      // partagés par tous les tenants) et ceux du tenant défaut. Les providers
      // d'un autre tenant ne doivent jamais être résolvables ici — sinon un
      // login SSO d'un tenant voisin fuirait dans le registre partagé.
      //
      // LIMITATION CONNUE (documentée, non levée ici) : le CRUD admin d'un
      // tenant liste et modifie pourtant ses providers tenant-scoped
      // (routes/providers.routes.ts) — l'admin peut voir/modifier une row que
      // le registre de runtime ne hydrate PAS. Conséquence assumée : un
      // fournisseur tenant-scoped (hors tenant défaut) est administrable mais
      // jamais utilisé par SSO. À résoudre quand le registre deviendra
      // tenant-aware (archi Authorization, portée = session.tenantId). Voir
      // aussi la politique de création POST (tenant défaut) qui garde le SSO
      // stable.
      if (row.tenantId !== null && row.tenantId !== DEFAULT_TENANT_ID) {
        continue
      }
      if (!SUPPORTED_KINDS.includes(row.kind)) {
        continue
      }
      try {
        const config = {
          ...row.config,
          enabled: row.enabled,
          name: row.name,
        } as Parameters<typeof createProvider>[2]
        const provider = createProvider(row.kind, row.id, config)
        next.set(provider.id, provider)
      } catch {
        // Config incomplète ou paramètres invalides → provider non hydraté
        // (visible en DB mais indisponible pour SSO jusqu'à configuration valide).
      }
    }
    this.providers = next
  }
}

export const providerRegistry = new ProviderRegistry()

// Initialisation au chargement du module : seuls les providers activés sont
// enregistrés (local + presets activés).
providerRegistry.registerSeeds()
