import { createContext, useContext, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

/**
 * Contexte du compte courant + helper d'autorisation `can(minRole)`.
 *
 * Les rangs DOIVENT rester alignés sur le backend (modules/auth/rbac.ts :
 * viewer<operator<owner). C'est ce qui permet à l'UI de masquer/désactiver les
 * actions qu'un rôle ne peut pas faire AU LIEU de laisser tomber un 403 opaque.
 * NB : c'est un confort UX, pas la sécurité — le backend reste l'autorité (chaque
 * route mutante a son requireRole).
 */
export type Role = "owner" | "operator" | "viewer"

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }

export type Me = { id: string; email: string; role: Role; mfaEnabled: boolean }

type MeContextValue = {
  me: Me | undefined
  isLoading: boolean
  can: (min: Role) => boolean
}

const MeContext = createContext<MeContextValue | null>(null)

export function MeProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({ queryKey: ["me"], queryFn: api.me })
  const me = data as Me | undefined
  const can = (min: Role) => {
    if (!me) return false
    return (RANK[me.role] ?? -1) >= RANK[min]
  }
  return <MeContext.Provider value={{ me, isLoading, can }}>{children}</MeContext.Provider>
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext)
  if (!ctx) throw new Error("useMe doit être utilisé dans <MeProvider>")
  return ctx
}
