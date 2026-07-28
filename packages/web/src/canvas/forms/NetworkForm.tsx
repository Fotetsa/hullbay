import { Input, Label, Switch, Select, Text } from "@medusajs/ui"
// Sous-chemin node-config : évite de tirer labels.ts (node:crypto) dans le bundle.
import type { NetworkConfig } from "@hullbay/shared/node-config"
import { KeyValueEditor } from "./KeyValueEditor"

/** Formulaire réseau : driver, interne, attachable, IPAM (subnet/gateway), labels. */
export function NetworkForm({
  config,
  onChange,
}: {
  config: Partial<NetworkConfig>
  onChange: (n: Partial<NetworkConfig>) => void
}) {
  const ipam = config.ipam ?? {}
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label size="small">Driver</Label>
        <Select
          value={config.driver ?? "overlay"}
          onValueChange={(v) => onChange({ ...config, driver: v as NetworkConfig["driver"] })}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="overlay">overlay</Select.Item>
            <Select.Item value="bridge">bridge</Select.Item>
          </Select.Content>
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <Label size="small">Réseau interne (pas d'accès sortant)</Label>
        <Switch
          checked={config.internal ?? false}
          onCheckedChange={(c) => onChange({ ...config, internal: c })}
        />
      </div>
      <div className="flex items-center justify-between">
        <Label size="small">Attachable (docker network connect externe)</Label>
        <Switch
          checked={config.attachable ?? true}
          onCheckedChange={(c) => onChange({ ...config, attachable: c })}
        />
      </div>

      <div>
        <Text size="small" weight="plus" className="mb-1">
          IPAM (laisser vide = automatique)
        </Text>
        <div className="flex flex-col gap-2">
          <div>
            <Label size="small">Subnet</Label>
            <Input
              placeholder="10.20.0.0/24"
              value={ipam.subnet ?? ""}
              onChange={(e) => onChange({ ...config, ipam: { ...ipam, subnet: e.target.value || undefined } })}
            />
          </div>
          <div>
            <Label size="small">Gateway</Label>
            <Input
              placeholder="10.20.0.1"
              value={ipam.gateway ?? ""}
              onChange={(e) => onChange({ ...config, ipam: { ...ipam, gateway: e.target.value || undefined } })}
            />
          </div>
        </div>
      </div>

      <KeyValueEditor
        label="Labels Docker"
        values={config.labels ?? {}}
        onChange={(labels) => onChange({ ...config, labels })}
      />
    </div>
  )
}
