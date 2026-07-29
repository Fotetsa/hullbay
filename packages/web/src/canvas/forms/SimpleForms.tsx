import { Input, Label, Switch } from "@medusajs/ui"
import type { GatewayConfig } from "@hullbay/shared"

/** Formulaire passerelle internet (exposition publique via Caddy). */
export function GatewayForm({
  config,
  onChange,
}: {
  config: Partial<GatewayConfig>
  onChange: (n: Partial<GatewayConfig>) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label size="small">Domaine public</Label>
        <Input
          value={config.domain ?? ""}
          onChange={(e) => onChange({ ...config, domain: e.target.value })}
          placeholder="app.bozando.com"
        />
      </div>
      <div>
        <Label size="small">Port cible (du conteneur)</Label>
        <Input
          type="number"
          value={config.targetPort ?? ""}
          onChange={(e) => onChange({ ...config, targetPort: Number(e.target.value) })}
          placeholder="80"
        />
      </div>
      <div className="flex items-center justify-between">
        <Label size="small">HTTPS automatique</Label>
        <Switch
          checked={config.tls ?? true}
          onCheckedChange={(c) => onChange({ ...config, tls: c })}
        />
      </div>
    </div>
  )
}
