import { PrismaClient } from "@prisma/client";
import { syncCatalog } from "../presets.mjs";

const prisma = new PrismaClient();
syncCatalog(prisma)
  .then((r) => {
    console.log(`[SYNC] Owner mis à jour : ${r.updated.length} tenant(s)`);
    for (const s of r.skipped)
      console.warn(`[SYNC] ignoré ${s.tenantId} : ${s.reason}`);
  })
  .catch((err) => {
    console.error("Échec de sync-catalog :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
