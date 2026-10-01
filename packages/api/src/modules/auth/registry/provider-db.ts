/**
 * Couche de persistance du Provider Registry (AuthProvider = source
 * de vérité).
 *
 * - syncProviderSeedsToDb() : upsert des seeds (presets + test IdP) dans
 *   AuthProvider, champs sensibles chiffrés individuellement (clientSecret…).
 *   Réconcilie les ids hérités de la migration initiale ("provider-*" → "local",
 *   "oidc-generic", …) pour aligner AuthProvider.id sur le registre.
 * - loadProviderRows() : lecture des enregistrements AuthProvider pour hydrater
 *   le ProviderRegistry au boot.
 *
 * Ce module est séparé de seeds.ts pour garder celui-ci pur (aucune dépendance
 * prisma) — provider-registry.test importe PROVIDER_SEEDS sans DB.
 */

import { prisma } from "../../../lib/prisma"
import type { Prisma } from "@prisma/client"
import type { ProviderKind } from "../providers/types"
import { encryptObject, decryptObject } from "../secrets/secret-encryption-service"
import { SENSITIVE_FIELDS_BY_KIND, PROVIDER_SEEDS, loadTestOidcSeed, loadTestSamlSeed, SUPERSEDED_GENERIC_IDS } from "./seeds"

/**
 * Ids des rows insérées par la migration initiale (convention "provider-<kind>",
 * config "{}"). Remplacées par l'upsert des seeds — supprimée pour éviter les
 * doublons ("provider-local" vs "local"). Config vide : aucune donnée perdue.
 */
const LEGACY_MIGRATION_IDS = [
  "provider-local",
  "provider-oidc",
  "provider-oauth2",
  "provider-saml",
  "provider-ldap",
]

/** Toutes les seeds enregistrables : presets + test IdP (si env présentes). */
export function allSeeds() {
  return [...PROVIDER_SEEDS, loadTestOidcSeed(), loadTestSamlSeed()].filter(
    (seed): seed is NonNullable<typeof seed> => seed !== null,
  )
}

/** Enregistrements AuthProvider prêts à être hydratés vers le registre. */
export type ProviderDbRow = {
  id: string
  kind: ProviderKind
  name: string
  enabled: boolean
  config: Record<string, unknown>
  /** null = provider global (disponible pour tous les tenants). */
  tenantId: string | null
}

/**
 * Upsert seeds → AuthProvider (id stable). Champs sensibles chiffrés en base.
 * Retire les rows placeholder de la migration initiale : leurs ids ("provider-*")
 * ne correspondent pas aux ids du registre et ne portent aucune config.
 */
export async function syncProviderSeedsToDb(): Promise<string[]> {
  const syncedIds: string[] = []
  for (const seed of allSeeds()) {
    const config: Prisma.InputJsonValue = seed.config
      ? (encryptObject(
          seed.config as unknown as Record<string, unknown>,
          SENSITIVE_FIELDS_BY_KIND[seed.kind as ProviderKind] ?? [],
        ) as Prisma.InputJsonValue)
      : {}
    await prisma.authProvider.upsert({
      where: { id: seed.id },
      create: { id: seed.id, kind: seed.kind, name: seed.name, enabled: seed.enabled, config },
      update: { kind: seed.kind, name: seed.name, enabled: seed.enabled, config },
    })
    syncedIds.push(seed.id)
  }

  await prisma.authProvider.deleteMany({ where: { id: { in: LEGACY_MIGRATION_IDS } } })

  // Presets historiques non paramétrés (config vide) : retirés au boot — les
  // seeds ne les portent plus. Une row CONFIGURÉE (ancien paramétrage manuel)
  // est conservée : on ne détruit jamais une config utilisateur.
  const staleRows = await prisma.authProvider.findMany({
    where: { id: { in: SUPERSEDED_GENERIC_IDS } },
    select: { id: true, config: true },
  })
  const toDrop = staleRows
    .filter((r) => !Object.entries((r.config as Record<string, unknown>) ?? {}).some(([, v]) => v !== null && v !== ""))
    .map((r) => r.id)
  if (toDrop.length > 0) {
    await prisma.authProvider.deleteMany({ where: { id: { in: toDrop } } })
  }
  return syncedIds
}

/** Lit AuthProvider pour hydrater le registre (config déchiffrée par champ sensible). */
export async function loadProviderRows(): Promise<ProviderDbRow[]> {
  const rows = await prisma.authProvider.findMany({ orderBy: { id: "asc" } })
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ProviderKind,
    name: row.name,
    enabled: row.enabled,
    tenantId: row.tenantId,
    config: decryptObject(
      (row.config as Record<string, unknown>) ?? {},
      SENSITIVE_FIELDS_BY_KIND[row.kind as ProviderKind] ?? [],
    ),
  }))
}