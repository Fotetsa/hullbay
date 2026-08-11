import { useQuery } from "@tanstack/react-query"
import { api, type UpdatesCheck } from "./api"

/** Intervalle de polling du check de mise à jour (6 h, volontairement discret). */
export const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000

/**
 * Check de mise à jour de l'instance, pollé toutes les 6 h. Le champ `enabled`
 * sert à ne lancer la requête que pour les owners (le backend refuse sinon).
 * Utilisé par la page Mises à jour ET le badge dans la sidebar → query key
 * partagée, un seul appel réseau en mémoire.
 */
export function useUpdatesCheck(enabled = true) {
  return useQuery<UpdatesCheck>({
    queryKey: ["updates-check"],
    queryFn: () => api.updatesCheck(),
    refetchInterval: UPDATE_CHECK_INTERVAL,
    staleTime: UPDATE_CHECK_INTERVAL,
    enabled,
  })
}
