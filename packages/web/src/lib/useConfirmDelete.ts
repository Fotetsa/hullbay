import { usePrompt } from "@medusajs/ui"
import type { QueryKey } from "@tanstack/react-query"
import { useMutationToast } from "./useMutationToast"

/**
 * Suppression confirmée : ouvre un dialogue de confirmation (usePrompt) puis,
 * si l'utilisateur valide, exécute la mutation de suppression (toast succès +
 * invalidation via useMutationToast). Centralise le pattern "êtes-vous sûr ?"
 * répété sur toutes les pages.
 *
 * Usage :
 *   const remove = useConfirmDelete({
 *     mutationFn: (id) => api.deleteX(id),
 *     success: "Supprimé",
 *     invalidate: [["xs"]],
 *     confirm: (vars) => ({ title: "Supprimer ?", description: `...` }),
 *   })
 *   <button onClick={() => remove(id)} />
 */
export function useConfirmDelete<TVars>({
  mutationFn,
  success,
  invalidate,
  confirm,
  onSuccess,
}: {
  mutationFn: (vars: TVars) => Promise<unknown>;
  success?: string | ((response: unknown) => string);
  invalidate?: QueryKey[];
  confirm: (vars: TVars) => {
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
  };
  onSuccess?: (vars: TVars) => void;
}) {
  const prompt = usePrompt();
  const mutation = useMutationToast<unknown, TVars>({
    mutationFn,
    success: success as any,
    invalidate,
    onSuccess: (_d, vars) => onSuccess?.(vars),
  });

  return async (vars: TVars) => {
    const c = confirm(vars);
    const ok = await prompt({
      title: c.title,
      description: c.description,
      confirmText: c.confirmText ?? "Supprimer",
      cancelText: c.cancelText ?? "Annuler",
      variant: "danger",
    });
    if (!ok) return;
    mutation.mutate(vars);
  };
}
