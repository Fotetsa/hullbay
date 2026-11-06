import type { Decision } from "../engine/types";

export type HttpOutcome = { status: number; body: { error: string } }
/** Correspondance décision -> HTTP. Le corps ne contient jamais reason ni sources. */

export function outcomeFor(d: Decision): HttpOutcome | null {
    if (d.allowed) return null
    switch (d.reason) {
        case "resource_not_found":
        case "tenant_mismatch":
        case "invalid_resource":
            return { status: 404, body: { error: "ressource introuvable" } }
        case "unknown_permission":
            return { status: 500, body: { error: "erreur interne" } }
        default:
            return { status: 403, body: { error: "permission insuffisante" } }
    }
}