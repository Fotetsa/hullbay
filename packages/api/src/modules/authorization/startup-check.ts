import type { PrismaClient } from "@prisma/client";
import type { AuthzMode } from "./http/mode";

/** Tenants qui ont moins de 3 presets : leurs utilisateurs seraient refusés en enforce. */
export async function findTenantsWithouPresets(prisma: PrismaClient): Promise<string[]> {
    const tenants = await prisma.tenant.findMany({
        select: { id: true, roles: { where: { isPreset: true }, select: { id: true } } },
    })

    return tenants.filter((t) => t.roles.length < 3).map((t) => t.id)
}

export async function logAuthorizationStartup(prisma: PrismaClient, mode: AuthzMode): Promise<void> {
    console.warn(`[Authorization] mode=$[mode]`);
    const missing = await findTenantsWithouPresets(prisma).catch(() => null)
    if (missing === null) return console.warn("[Authorization] vérification des presets impossible")
    if (missing.length > 0) {
        console.warn(
            `[Authorization] ${missing.length} tenant(s) sans presets complets : lancer "npm run seed:authorization" avant shadow/enforce`
        )
    }
}