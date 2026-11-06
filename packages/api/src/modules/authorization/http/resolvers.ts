import type { FastifyRequest } from "fastify"
import type { Resource } from "../engine/types"
import type { ScopeType } from "../scope"

export type ResourceExtractor = (req: FastifyRequest) => Resource | undefined | Promise<Resource | undefined>

const asId = (v: unknown) => (typeof v === "string" ? v : "")

/**
 * L'identifiant client désigne la ressource visée, jamais le tenant. Un identifiant
 * absent donne id "" : le moteur répond resource_not_found (404 uniforme).
 */

export const fromParam =
    (name: string, type: ScopeType): ResourceExtractor =>
    (req) => ({ type, id: asId((req.params as Record<string, unknown> | undefined)?.[name]) })

export const fromBody = 
    (field: string, type: ScopeType): ResourceExtractor =>
    (req) => ({ type, id: asId((req.body as Record<string, unknown> | undefined)?.[field]) })
    
export const fromBodyIfPresent = 
    (field: string, type: ScopeType): ResourceExtractor =>
        (req) => {
            const v = (req.body as Record<string, unknown> | undefined | null)?.[field]
            if (v === undefined || v === null) return undefined
            return { type, id: asId(v) }
    }