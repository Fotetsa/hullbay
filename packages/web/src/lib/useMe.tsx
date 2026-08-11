import { createContext, useContext, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { api } from "./api"

export type Role = "owner" | "operator" | "viewer"

const RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 }

export type Me = { id: string; email: string; role: Role; mfaEnabled: boolean }

type MeContextValue = {
  me: Me | undefined
  isLoading: boolean
  isError: boolean
  error?: unknown
  can: (min: Role) => boolean
}

const MeContext = createContext<MeContextValue | null>(null)

export function MeProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    staleTime: 15_000,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })

  const me = data as Me | undefined
  const can = (min: Role) => {
    if (!me) return false
    return (RANK[me.role] ?? -1) >= RANK[min]
  }

  return <MeContext.Provider value={{ me, isLoading, isError, error, can }}>{children}</MeContext.Provider>
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext)
  if (!ctx) throw new Error("useMe doit être utilisé dans <MeProvider>")
  return ctx
}
