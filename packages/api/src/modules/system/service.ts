export type Environment = "development" | "test" | "production"

/**
 * Résout l'environnement d'execution du process. Toujours un repli sur le comportement le plus 
 * strict (production) si la valeur est abscente ou inattendue, jamais le plus permissif.
 */

export function resolveEnvironment(): Environment {
    const raw = process.env.NODE_ENV
    if (raw === "development" || raw === "test" || raw === "production") return raw
    return "production"
}