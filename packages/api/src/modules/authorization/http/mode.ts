export type AuthzMode = "legacy" | "shadow" | "enforce"

const MODES = new Set<string>(["legacy", "shadow", "enforce"])

/**
 * Mode inconnu = enforce (jamais legacy : fail closed). Valeur absente = enforce, sauf
 * sous NODE_ENV=test où le legacy est le défaut, pour que les suites de routes
 * existantes (qui simulent Prisma) restent inchangées. Le premier déploiement fixe
 * AUTHZ_MODE=legacy explicitement.
 */

export function resolveMode(
    raw: string | undefined = process.env.AUTHZ_MODE,
    nodeEnv: string | undefined = process.env.NODE_ENV,
): AuthzMode {
    const v = raw?.trim().toLowerCase()
    if (v && MODES.has(v)) return v as AuthzMode
    if (!v && nodeEnv === "test") return "legacy"
    return "enforce"
}