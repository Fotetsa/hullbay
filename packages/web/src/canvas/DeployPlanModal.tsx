import { useQuery } from "@tanstack/react-query"
import { Badge, Button, FocusModal, Heading, Text } from "@medusajs/ui"
import { ExclamationCircle, InformationCircle, PlaySolid } from "@medusajs/icons"
import type { ProjectGraph } from "@hullbay
import { api, type DiffAction } from "../lib/api"
import { validateGraph, type ValidationIssue } from "./validate"

/**
 * Modal "Revoir et déployer" (référence Azure "Review + create" / Railway).
 * Affiche AVANT d'appliquer :
 *  1. les avertissements/erreurs de cohérence du graphe (validation côté client) ;
 *  2. le diff réel renvoyé par le backend (create/update/noop/remove des services).
 * Le déploiement est bloqué s'il reste une erreur de cohérence.
 */

const KIND_LABEL: Record<DiffAction["kind"], string> = {
  create: "Créer",
  update: "Mettre à jour",
  noop: "Inchangé",
  remove: "Supprimer",
}
const KIND_COLOR: Record<DiffAction["kind"], "green" | "orange" | "grey" | "red"> = {
  create: "green",
  update: "orange",
  noop: "grey",
  remove: "red",
}

function actionName(a: DiffAction): string {
  return "node" in a ? a.node.name : a.name
}

export function DeployPlanModal({
  open,
  onOpenChange,
  graph,
  onConfirm,
  isDeploying,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  graph: ProjectGraph
  onConfirm: () => void
  isDeploying: boolean
}) {
  const issues: ValidationIssue[] = validateGraph(graph)
  const errors = issues.filter((i) => i.severity === "error")
  const warnings = issues.filter((i) => i.severity === "warning")

  const { data: plan, isLoading: planLoading } = useQuery({
    queryKey: ["plan", graph.id],
    queryFn: () => api.plan(graph.id),
    enabled: open,
  })

  const actions = (plan?.actions ?? []).filter((a) => a.kind !== "noop")
  const noopCount = (plan?.actions ?? []).length - actions.length
  const blocked = errors.length > 0

  return (
    <FocusModal open={open} onOpenChange={onOpenChange}>
      <FocusModal.Content>
        <FocusModal.Header>
          <Heading>Revoir et déployer · {graph.name}</Heading>
        </FocusModal.Header>
        <FocusModal.Body className="overflow-y-auto">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-8">
          {/* Cohérence */}
          {issues.length > 0 && (
            <div className="flex flex-col gap-2">
              <Heading level="h3">Vérifications</Heading>
              {errors.map((i, k) => (
                <div
                  key={`e${k}`}
                  className="flex items-start gap-2 rounded-lg border border-ui-border-error bg-ui-bg-base p-3"
                >
                  <ExclamationCircle className="mt-0.5 shrink-0 text-ui-fg-error" />
                  <Text size="small" className="text-ui-fg-error">
                    {i.message}
                  </Text>
                </div>
              ))}
              {warnings.map((i, k) => (
                <div
                  key={`w${k}`}
                  className="flex items-start gap-2 rounded-lg border border-ui-border-base bg-ui-bg-base p-3"
                >
                  <InformationCircle className="mt-0.5 shrink-0 text-ui-tag-orange-icon" />
                  <Text size="small" className="text-ui-fg-subtle">
                    {i.message}
                  </Text>
                </div>
              ))}
            </div>
          )}

          {/* Diff */}
          <div className="flex flex-col gap-2">
            <Heading level="h3">Changements à appliquer</Heading>
            {planLoading ? (
              <Text size="small" className="text-ui-fg-subtle">
                Calcul du plan…
              </Text>
            ) : actions.length === 0 ? (
              <Text size="small" className="text-ui-fg-subtle">
                Aucun changement de service à appliquer
                {noopCount > 0 ? ` (${noopCount} déjà à jour).` : "."} Les réseaux,
                volumes et passerelles sont (re)configurés de façon idempotente au
                déploiement.
              </Text>
            ) : (
              <div className="flex flex-col divide-y divide-ui-border-base rounded-lg border border-ui-border-base">
                {actions.map((a, k) => (
                  <div key={k} className="flex items-center justify-between px-3 py-2">
                    <Text size="small">{actionName(a)}</Text>
                    <Badge size="2xsmall" color={KIND_COLOR[a.kind]}>
                      {KIND_LABEL[a.kind]}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
            {noopCount > 0 && actions.length > 0 && (
              <Text size="xsmall" className="text-ui-fg-muted">
                {noopCount} service(s) déjà à jour (inchangés).
              </Text>
            )}
          </div>

          {blocked && (
            <Text size="small" className="text-ui-fg-error">
              Corrige les erreurs ci-dessus avant de déployer.
            </Text>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button onClick={onConfirm} isLoading={isDeploying} disabled={blocked}>
              <PlaySolid /> Déployer
            </Button>
          </div>
          </div>
        </FocusModal.Body>
      </FocusModal.Content>
    </FocusModal>
  )
}
