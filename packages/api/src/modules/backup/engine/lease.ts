import { prisma } from "../../../lib/prisma"

/**
 * Lease d'exécution : garantit qu'une seule instance Hullbay lance un backup
 * donné. Pas d'advisory lock de session (incompatible avec le pooling Prisma) :
 * une mise à jour conditionnelle suffit et reste atomique en Postgres.
 */

export interface LeaseOptions {
  owner: string
  ttlMs?: number
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000

export async function acquireLease(
  policyId: string,
  options: LeaseOptions,
): Promise<boolean> {
  const now = new Date()
  const result = await prisma.backupPolicy.updateMany({
    where: {
      id: policyId,
      enabled: true,
      OR: [{ lockExpiresAt: null }, { lockExpiresAt: { lt: now } }],
    },
    data: {
      lockedBy: options.owner,
      lockExpiresAt: new Date(now.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS)),
    },
  })
  return result.count === 1
}

/** Renouvelle le lease si (et seulement si) on en est toujours propriétaire. */
export async function renewLease(
  policyId: string,
  options: LeaseOptions,
): Promise<boolean> {
  const result = await prisma.backupPolicy.updateMany({
    where: { id: policyId, lockedBy: options.owner },
    data: {
      lockExpiresAt: new Date(Date.now() + (options.ttlMs ?? DEFAULT_TTL_MS)),
    },
  })
  return result.count === 1
}

export async function releaseLease(policyId: string, owner: string): Promise<void> {
  await prisma.backupPolicy.updateMany({
    where: { id: policyId, lockedBy: owner },
    data: { lockedBy: null, lockExpiresAt: null },
  })
}
