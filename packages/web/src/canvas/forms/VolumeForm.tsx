import { Input, Label, Switch, Text } from "@medusajs/ui"
// Sous-chemin node-config : évite de tirer labels.ts (node:crypto) dans le bundle.
import type { VolumeConfig } from "@hullbayred/node-config"
import { KeyValueEditor } from "./KeyValueEditor"

/** Formulaire volume : driver/driver_opts/labels, ou référence à un volume externe. */
export function VolumeForm({
  config,
  onChange,
}: {
  config: Partial<VolumeConfig>
  onChange: (n: Partial<VolumeConfig>) => void
}) {
  const external = config.external ?? false
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Label size="small">Volume Docker externe (déjà existant)</Label>
        <Switch checked={external} onCheckedChange={(c) => onChange({ ...config, external: c })} />
      </div>

      {external ? (
        <div>
          <Label size="small">Nom du volume existant</Label>
          <Input
            value={config.externalName ?? ""}
            onChange={(e) => onChange({ ...config, externalName: e.target.value })}
            placeholder="mon-volume-existant"
          />
          <Text size="xsmall" className="mt-1 text-ui-fg-muted">
            Aucun volume ne sera créé : le déploiement référence ce nom exact tel quel (pas de
            préfixe boz_&lt;projet&gt;_).
          </Text>
        </div>
      ) : (
        <>
          <div>
            <Label size="small">Driver</Label>
            <Input
              value={config.driver ?? "local"}
              onChange={(e) => onChange({ ...config, driver: e.target.value })}
            />
          </div>
          <KeyValueEditor
            label="Options driver"
            values={config.driverOpts ?? {}}
            onChange={(driverOpts) => onChange({ ...config, driverOpts })}
            keyPlaceholder="ex: type"
            valuePlaceholder="ex: nfs"
          />
          <KeyValueEditor
            label="Labels Docker"
            values={config.labels ?? {}}
            onChange={(labels) => onChange({ ...config, labels })}
          />
        </>
      )}
    </div>
  )
}
