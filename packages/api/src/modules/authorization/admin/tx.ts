import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Transaction d'administration : toutes les écritures d'un tenant sont sérialisées par un
 * verrou consultatif. Le contrôle anti-verrouillage et les vérifications « rôle utilisé »
 * lisent donc un état stable, y compris sous concurrence.
 */
export async function adminTx<T>(
  db: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      const key = `hullbay:authz-admin:t:${tenantId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      return fn(tx);
    },
    { timeout: 30000, maxWait: 15000 },
  );
}
