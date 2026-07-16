import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query"
import { toast } from "@medusajs/ui"

type Options<TData, TVars> = {
  mutationFn: (vars: TVars) => Promise<TData>
  /**
   * Message de succès. String fixe, ou fonction du résultat pour un message
   * dynamique (ex. `(r) => \`Reconstruit : ${r.projects} projets\``).
   */
  success?: string | ((data: TData, vars: TVars) => string)
  /** Description optionnelle du toast de succès. */
  successDescription?: string | ((data: TData, vars: TVars) => string)
  /** Query keys à invalider après succès. */
  invalidate?: QueryKey[]
  /** Titre du toast d'erreur (défaut : "Erreur"). */
  errorTitle?: string
  /** Durée d'affichage du toast d'erreur en millisecondes (défaut: 5000). Utilisé pour les erreurs critiques. */
  errorDuration?: number
  /** Callback additionnel après le succès (comportements spécifiques à la page). */
  onSuccess?: (data: TData, vars: TVars) => void
  /** Callback additionnel après l'erreur. */
  onError?: (err: Error, vars: TVars) => void
}

/**
 * Wrapper fin autour de useMutation qui applique le pattern répété dans tout le
 * front : toast de succès + invalidation de queries, toast d'erreur avec le
 * message. Les callbacks onSuccess/onError additionnels restent disponibles pour
 * les comportements spécifiques (ex. effacer un secret du state).
 */
export function useMutationToast<TData = unknown, TVars = void>({
  mutationFn,
  success,
  successDescription,
  invalidate,
  errorTitle = "Erreur",
  errorDuration,
  onSuccess,
  onError,
}: Options<TData, TVars>) {
  const qc = useQueryClient()
  return useMutation<TData, Error, TVars>({
    mutationFn,
    onSuccess: (data, vars) => {
      invalidate?.forEach((queryKey) => qc.invalidateQueries({ queryKey }))
      if (success) {
        const msg = typeof success === "function" ? success(data, vars) : success
        const desc =
          typeof successDescription === "function"
            ? successDescription(data, vars)
            : successDescription
        toast.success(msg, desc ? { description: desc } : undefined)
      }
      onSuccess?.(data, vars)
    },
    onError: (err, vars) => {
      const errorOptions: any = { description: err.message }
      if (errorDuration !== undefined) {
        errorOptions.duration = errorDuration
      }
      toast.error(errorTitle, errorOptions)
      onError?.(err, vars)
    },
  })
}
