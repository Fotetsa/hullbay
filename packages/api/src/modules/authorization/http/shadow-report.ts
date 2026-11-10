export type Divergence = "engine_stricter" | "engine_more_permissive"

export function divergenceOf(legacyAllowed: boolean, engineAllowed: boolean): Divergence | null {
    if (legacyAllowed === engineAllowed) return null
    return legacyAllowed ? "engine_stricter" : "engine_more_permissive"
}