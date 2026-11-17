import { PrismaClient } from "@prisma/client";
import { ensurePermissions, ensureTenantPresets } from "../presets.mjs";

const prisma = new PrismaClient();

async function main() {
  const byKey = await ensurePermissions(prisma);
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const t of tenants) await ensureTenantPresets(prisma, t.id, byKey);
  console.log(
    `[SEED] terminé pour ${tenants.length} tenant(s), ${byKey.size} permissions.`,
  );
}

main()
  .catch((err) => {
    console.error("Échec du peuplement :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
