export type Environment = "development" | "test" | "production";

/**
 * Résout l'environnement d'exécution du process. Toujours un repli sur le
 * comportement le plus strict (production) si la valeur est absente ou
 * inattendue.
 */
export function resolveEnvironment(): Environment {
  const raw = process.env.NODE_ENV?.toLowerCase().trim();
  if (raw === "development" || raw === "test" || raw === "production")
    return raw;
  return "production";
}
