import type { PrismaClient } from "@prisma/client";
import { ensurePermissions, ensureTenantPresets } from "../presets.mjs";

/** Point d'entrée unique pour doter un tenant de ses quatre rôles. */
export async function createTenantPresets(
  db: PrismaClient,
  tenantId: string,
): Promise<void> {
  const byKey = await ensurePermissions(db);
  await ensureTenantPresets(db, tenantId, byKey);
}
