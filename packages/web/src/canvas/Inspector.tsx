import { useEffect, useState } from "react"
import { Button, Heading, Input, Label, Text, toast, usePrompt } from "@medusajs/ui"
import { Trash, XMark, CommandLine } from "@medusajs/icons"
import { z } from "zod"
import type { Node } from "@hullbay/shared"
// Import depuis le sous-chemin node-config : évite de tirer labels.ts (node:crypto)
// dans le bundle navigateur via le barrel index.ts.
import { parseNodeConfig, type NodeType, type VolumeConfig } from "@hullbay/shared/node-config"
import { api } from "../lib/api"
import { ContainerForm } from "./forms/ContainerForm"
import { NetworkForm } from "./forms/NetworkForm"
import { VolumeForm } from "./forms/VolumeForm"
import { GatewayForm } from "./forms/SimpleForms"
import { useContainerLogs } from "../lib/useContainerLogs"

/**
 * Inspecteur (panneau latéral droit) : édite le nœud sélectionné.
 * Nom + config typée selon le type. Sauvegarde via l'API, supprime le nœud.
 */
export function Inspector({
  node,
  onClose,
  onSaved,
  onDeleted,
}: {
  node: Node
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const prompt = usePrompt()
  const [name, setName] = useState(node.name)
  const [config, setConfig] = useState<Record<string, unknown>>(node.config)
  const [saving, setSaving] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  // Logs streamés seulement quand le panneau logs est ouvert et le conteneur déployé.
  const logs = useContainerLogs(showLogs ? node.dockerId ?? null : null)

  // Recharge l'état local quand on change de nœud sélectionné.
  useEffect(() => {
    setName(node.name)
    setConfig(node.config)
    setShowLogs(false)
  }, [node.id])

  async function save() {
    // Valide la config AVANT l'envoi : message de champ précis (ex. "domain requis")
    // au lieu d'un aller-retour 400 opaque. Même schéma partagé que le backend.
    try {
      parseNodeConfig(node.type as NodeType, config)
    } catch (e) {
      const msg =
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join(" · ")
          : (e as Error).message
      toast.error("Configuration invalide", { description: msg })
      return
    }
    setSaving(true)
    try {
      await api.updateNode(node.id, { name, config })
      toast.success("Nœud enregistré")
      onSaved()
    } catch (e) {
      toast.error("Erreur", { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    const ok = await prompt({
      title: "Supprimer ce nœud ?",
      description: `« ${node.name} » (${node.type}) sera retiré du projet. S'il est déployé, détruis/redéploie le projet pour appliquer le changement à Docker.`,
      confirmText: "Supprimer",
      cancelText: "Annuler",
      variant: "danger",
    })
    if (!ok) return
    try {
      await api.deleteNode(node.id)
      toast.success("Nœud supprimé")
      onDeleted()
    } catch (e) {
      toast.error("Erreur", { description: (e as Error).message })
    }
  }

  return (
    <div
      className="absolute right-4 top-4 bottom-4 z-10 flex w-[360px] flex-col overflow-hidden rounded-xl border border-ui-border-base bg-ui-bg-base shadow-elevation-flyout"
      role="dialog"
      aria-label={`Configuration du nœud ${node.name}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose()
      }}
    >
      <div className="flex items-center justify-between border-b border-ui-border-base px-4 py-3">
        <Heading level="h3" className="capitalize">
          {node.type}
        </Heading>
        <Button variant="transparent" size="small" onClick={onClose} aria-label="Fermer l'inspecteur">
          <XMark />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="mb-4">
          <Label size="small">Nom du nœud</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Text size="xsmall" className="mt-1 text-ui-fg-muted">
            {node.type === "volume" && (config as Partial<VolumeConfig>).external
              ? `Volume Docker existant : ${(config as Partial<VolumeConfig>).externalName || "…"}`
              : <>Ressource Docker : boz_&lt;projet&gt;_{name || "…"}</>}
          </Text>
        </div>

        {node.type === "container" && <ContainerForm config={config} onChange={setConfig} />}
        {node.type === "network" && <NetworkForm config={config} onChange={setConfig} />}
        {node.type === "volume" && <VolumeForm config={config} onChange={setConfig} />}
        {node.type === "gateway" && <GatewayForm config={config} onChange={setConfig} />}

        {/* Logs (conteneurs déployés uniquement). */}
        {node.type === "container" && node.dockerId && (
          <div className="mt-4">
            <Button variant="secondary" size="small" onClick={() => setShowLogs((v) => !v)}>
              <CommandLine /> {showLogs ? "Masquer les logs" : "Voir les logs"}
            </Button>
            {showLogs && (
              <pre
                className="mt-2 max-h-60 overflow-auto rounded-lg bg-ui-bg-base-pressed p-2 text-ui-fg-subtle txt-compact-xsmall font-mono"
                aria-live="polite"
                aria-label="Logs du conteneur"
              >
                {logs.length ? logs.join("") : "En attente de logs…"}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ui-border-base p-4">
        <Button variant="danger" onClick={remove}>
          <Trash /> Supprimer
        </Button>
        <Button onClick={save} isLoading={saving}>
          Enregistrer
        </Button>
      </div>
    </div>
  )
}
