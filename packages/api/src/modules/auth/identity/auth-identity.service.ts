/**
 * Service identité : helpers pour la création/lookup d'identités locales
 * et la résolution du tenant par défaut.
 */

import { prisma } from "../../../lib/prisma"

/**
 * Id littéral du tenant par défaut (créé par la migration — id fixe).
 * Référencé par le backfill tenant-scope et le fallback d'isolation des données héritées.
 */
export const DEFAULT_TENANT_ID = "tenant-default"

export async function ensureDefaultTenant() {
  return prisma.tenant.upsert({
    where: { slug: "default" },
    create: { id: DEFAULT_TENANT_ID, name: "Default", slug: "default" },
    update: {},
  })
}

/**
 * Tenant effectif de l'utilisateur : sa première membership (tenant 'default'
 * prioritaire, sinon la plus récente). Fallback : tenant par défaut (données
 * héritées sans membership explicite).
 */
export async function resolveTenantIdForUser(userId: string): Promise<string> {
  // Prisma partiellement mocké en tests : modèle absent → tenant par défaut.
  if (!prisma.membership?.findFirst) return DEFAULT_TENANT_ID
  const membership = await prisma.membership.findFirst({
    where: { userId },
    orderBy: [{ tenant: { slug: "asc" } }, { createdAt: "desc" }],
    select: { tenantId: true },
  })
  return membership?.tenantId ?? DEFAULT_TENANT_ID
}

/**
 * Auto-répare le compte legacy qui a un rôle global mais pas de membership
 * dans le tenant défaut. Cette correction est idempotente et évite les 403 sur
 * le secret drawer pour les comptes existants avant le backfill multi-tenant.
 */
export async function ensureUserHasDefaultMembership(userId: string): Promise<boolean> {
  if (!prisma.membership?.findUnique || !prisma.user?.findUnique) return true

  const tenant = await ensureDefaultTenant()
  const existing = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId, tenantId: tenant.id } },
    select: { userId: true },
  })
  if (existing) return true

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  })
  if (!user) return false

  await prisma.membership.upsert({
    where: { userId_tenantId: { userId, tenantId: tenant.id } },
    create: { userId, tenantId: tenant.id, role: user.role },
    update: { role: user.role },
  })
  return true
}

export async function backfillDefaultMemberships(): Promise<number> {
  if (!prisma.membership?.findMany || !prisma.user?.findMany) return 0

  const tenant = await ensureDefaultTenant()
  const users = await prisma.user.findMany({ select: { id: true, role: true } })
  const existing = await prisma.membership.findMany({
    where: { tenantId: tenant.id },
    select: { userId: true },
  })
  const existingSet = new Set(existing.map((m) => m.userId))

  let created = 0
  for (const user of users) {
    if (existingSet.has(user.id)) continue
    await prisma.membership.create({
      data: { userId: user.id, tenantId: tenant.id, role: user.role },
    })
    created += 1
  }

  return created
}

/**
 * Vérifie que l'utilisateur a une membership dans le tenant demandé.
 * plus de court-circuit sur DEFAULT_TENANT_ID — le header
 * `x-tenant-id: tenant-default` exige une membership par défaut comme n'importe
 * quel autre tenant (sinon un owner tenant-B escaladait via le tenant par défaut).
 * Backfill A3 garantit que les comptes hérités ont bien leur membership default.
 */
export async function assertUserInTenant(userId: string, tenantId: string): Promise<boolean> {
  if (!prisma.membership?.findUnique) return true
  const membership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: { tenantId: true },
  })
  return membership !== null
}

export type ResolvedRole = "owner" | "operator" | "viewer"

/**
 * Rôle effectif de l'utilisateur : résolu depuis SA membership
 * dans le tenant courant — le miroir `User.role` n'est plus la source de
 * vérité (fallback legacy pour les comptes sans membership / mocks).
 * le fallback cross-tenant (findFirst sur n'IMPORTE quelle
 * membership) est supprimé — une résolution hors du tenant courant ne doit
 * JAMAIS remonter un rôle d'un autre tenant (escalade tenant défaut).
 */
export async function resolveRoleForUser(
  userId: string,
  tenantId = DEFAULT_TENANT_ID,
  fallback: string = "viewer",
): Promise<ResolvedRole> {
  try {
    // Résolution explicite du rôle pour le tenant courant : la membership locale
    // a priorité absolue. On ne remonte jamais un rôle global à partir d'un
    // tenant explicite non-default sans membership valide.
    if (prisma.membership?.findUnique) {
      const membership = await prisma.membership
        .findUnique({
          where: { userId_tenantId: { userId, tenantId } },
          select: { role: true },
        })
        .catch(() => null)
      if (membership?.role) return membership.role as ResolvedRole
    }

    // Fail-closed pour tout tenant explicite autre que le tenant défaut.
    if (tenantId !== DEFAULT_TENANT_ID) {
      return "viewer"
    }

    // Seul le tenant par défaut conserve le fallback legacy, pour les comptes
    // hérités sans membership explicite.
    if (prisma.user?.findFirst) {
      const user = await prisma.user.findFirst({ where: { id: userId } }).catch(() => null)
      if (user?.role) return user.role as ResolvedRole
    }
  } catch {
    // Ignore et on retombe sur le fallback par défaut ci-dessous.
  }

  return (fallback as ResolvedRole) || "viewer"
}

export async function findLocalIdentityByEmail(email: string) {
  return prisma.authIdentity.findFirst({
    where: { kind: "local", email },
  })
}

export async function findLocalIdentityByUserId(userId: string) {
  return prisma.authIdentity.findFirst({
    where: { userId, kind: "local" },
  })
}

export async function findLocalIdentityWithUser(userId: string) {
  return prisma.authIdentity.findFirst({
    where: { userId, kind: "local" },
    include: { user: true },
  })
}
