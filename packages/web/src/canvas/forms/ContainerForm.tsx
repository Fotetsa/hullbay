import { Button, Input, Label, Select, Switch, Text } from "@medusajs/ui"
import { Plus, Trash } from "@medusajs/icons"
import { useQuery } from "@tanstack/react-query"
import type { ContainerConfig } from "@bozando-ops/shared"
import { api } from "../../lib/api"
// Sous-chemin node-config : évite de tirer labels.ts (node:crypto) dans le bundle.
import { effectivePullPolicy, type PullPolicy } from "@bozando-ops/shared/node-config"

/**
 * Formulaire complet de config d'un conteneur (référence Railway) : image, tag,
 * ports, variables d'env, commande, politique de redémarrage, ressources.
 * Édite un objet config "partiel" contrôlé par le parent (Inspector).
 */
type Cfg = Partial<ContainerConfig>

export function ContainerForm({
  config,
  onChange,
}: {
  config: Cfg
  onChange: (next: Cfg) => void
}) {
  const ports = config.ports ?? []
  const envEntries = Object.entries(config.env ?? {})
  const secrets = config.secrets ?? []
  const { data: availableSecrets, isLoading: secretsLoading, error: secretsError } = useQuery({
    queryKey: ["secrets"],
    queryFn: api.listSecrets,
    refetchOnMount: "always",
    retry: 1,
  })
  const secretNames = availableSecrets?.map((secret) => secret.name) ?? []
  const { data: availableRegistries, isLoading: registriesLoading, error: registriesError } = useQuery({
    queryKey: ["registry"],
    queryFn: api.listRegistry,
    refetchOnMount: "always",
    retry: 1,
  })
  const registryHosts = availableRegistries?.map((reg) => reg.registry) ?? []

  const set = (patch: Cfg) => onChange({ ...config, ...patch })

  return (
    <div className="flex flex-col gap-4">
      {/* Replicas (Swarm : load balancing natif via routing mesh) */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label size="small">Replicas</Label>
          <Input
            type="number"
            min={0}
            value={config.replicas ?? 1}
            onChange={(e) => set({ replicas: Number(e.target.value) })}
            placeholder="1"
          />
        </div>
        <div>
          <Label size="small">Maj parallèles (rolling)</Label>
          <Input
            type="number"
            min={1}
            value={config.updateParallelism ?? 1}
            onChange={(e) => set({ updateParallelism: Number(e.target.value) })}
            placeholder="1"
          />
        </div>
      </div>

      {/* Image + tag */}
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Label size="small">Image</Label>
          <Input
            list="canvas-image-options"
            value={config.image ?? ""}
            onChange={(e) => set({ image: e.target.value })}
            placeholder="nginx ou ghcr.io/mon-org/mon-app"
          />
          <Text size="xsmall" className="mt-1 text-ui-fg-muted">
            Tu peux saisir ton image complète ou choisir un registre déjà configuré.
          </Text>
          <datalist id="canvas-image-options">
            {registryHosts.map((registry) => (
              <option key={registry} value={registry} />
            ))}
          </datalist>
        </div>
        <div>
          <Label size="small">Tag</Label>
          <Input
            value={config.tag ?? ""}
            onChange={(e) => set({ tag: e.target.value })}
            placeholder="latest"
          />
        </div>
      </div>

      {/* Politique de pull (calquée Kubernetes imagePullPolicy) */}
      <div>
        <Label size="small">Récupération de l'image (pull policy)</Label>
        <Select
          value={config.pullPolicy ?? "__auto"}
          onValueChange={(v) =>
            set({ pullPolicy: v === "__auto" ? undefined : (v as PullPolicy) })
          }
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="__auto">
              Auto (déduit du tag : {effectivePullPolicy({ tag: config.tag ?? "latest" })})
            </Select.Item>
            <Select.Item value="Always">Always — toujours tirer du registre</Select.Item>
            <Select.Item value="IfNotPresent">IfNotPresent — tirer si absente localement</Select.Item>
            <Select.Item value="Never">Never — image locale uniquement (jamais de pull)</Select.Item>
          </Select.Content>
        </Select>
        <Text size="xsmall" className="mt-1 text-ui-fg-muted">
          `latest` ⇒ Always (re-tire à chaque déploiement, évite de servir une vieille image).
          Pour une image construite en local et non poussée, choisis Never (cluster mono-nœud).
          Pour un cluster, pousse-la sur un registre (ex. ghcr.io/...) + identifiants dans Registres.
        </Text>
      </div>

      {/* Politique de redémarrage */}
      <div>
        <Label size="small">Redémarrage</Label>
        <Select
          value={config.restartPolicy ?? "unless-stopped"}
          onValueChange={(v) => set({ restartPolicy: v as ContainerConfig["restartPolicy"] })}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {["no", "on-failure", "always", "unless-stopped"].map((p) => (
              <Select.Item key={p} value={p}>
                {p}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>

      {/* Ports */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label size="small">Ports</Label>
          <Button
            variant="transparent"
            size="small"
            onClick={() => set({ ports: [...ports, { container: 80, protocol: "tcp" }] })}
          >
            <Plus /> Ajouter
          </Button>
        </div>
        {ports.length === 0 && <Text size="small" className="text-ui-fg-muted">Aucun port</Text>}
        {ports.map((p, i) => (
          <div key={i} className="mb-1 flex items-center gap-2">
            <Input
              type="number"
              placeholder="conteneur"
              value={p.container}
              onChange={(e) => {
                const next = [...ports]
                next[i] = { ...p, container: Number(e.target.value) }
                set({ ports: next })
              }}
            />
            <span className="text-ui-fg-muted">→</span>
            <Input
              type="number"
              placeholder="hôte (optionnel)"
              value={p.host ?? ""}
              onChange={(e) => {
                const next = [...ports]
                next[i] = { ...p, host: e.target.value ? Number(e.target.value) : undefined }
                set({ ports: next })
              }}
            />
            <Button
              variant="transparent"
              size="small"
              onClick={() => set({ ports: ports.filter((_, j) => j !== i) })}
            >
              <Trash />
            </Button>
          </div>
        ))}
      </div>

      {/* Variables d'environnement */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label size="small">Variables d'environnement</Label>
          <Button
            variant="transparent"
            size="small"
            onClick={() => set({ env: { ...(config.env ?? {}), "": "" } })}
          >
            <Plus /> Ajouter
          </Button>
        </div>
        {envEntries.length === 0 && <Text size="small" className="text-ui-fg-muted">Aucune variable</Text>}
        {envEntries.map(([k, v], i) => (
          <div key={i} className="mb-1 flex items-center gap-2">
            <Input
              placeholder="CLÉ"
              value={k}
              onChange={(e) => {
                const next = { ...(config.env ?? {}) }
                delete next[k]
                next[e.target.value] = v
                set({ env: next })
              }}
            />
            <span className="text-ui-fg-muted">=</span>
            <Input
              placeholder="valeur"
              value={v}
              onChange={(e) => set({ env: { ...(config.env ?? {}), [k]: e.target.value } })}
            />
            <Button
              variant="transparent"
              size="small"
              onClick={() => {
                const next = { ...(config.env ?? {}) }
                delete next[k]
                set({ env: next })
              }}
            >
              <Trash />
            </Button>
          </div>
        ))}
      </div>

      {/* Secrets (Docker Secrets — montés en fichiers, valeurs hors config) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label size="small">Secrets</Label>
          <Button
            variant="transparent"
            size="small"
            onClick={() => set({ secrets: [...secrets, { secretName: "" }] })}
          >
            <Plus /> Ajouter
          </Button>
        </div>
        <Text size="xsmall" className="mb-1 text-ui-fg-muted">
          Référence un secret créé dans "Secrets" (monté en /run/secrets/&lt;nom&gt;).
          {secretsLoading ? " Chargement..." : ` ${secretNames.length} secret(s) disponibles`}
        </Text>
        {secrets.length === 0 && (
          <Text size="small" className="text-ui-fg-muted">
            Aucun secret référencé
          </Text>
        )}
        {secretsError && (
          <Text size="small" className="text-ui-fg-danger">
            Impossible de charger les secrets : {secretsError.message}
          </Text>
        )}
        {secrets.map((s, i) => (
          <div key={i} className="mb-1 flex items-center gap-2">
            <Input
              list="canvas-secret-options"
              placeholder="Sélectionne un secret"
              value={s.secretName}
              onChange={(e) => {
                const next = [...secrets]
                next[i] = { ...s, secretName: e.target.value }
                set({ secrets: next })
              }}
            />
            <Input
              placeholder="chemin (optionnel)"
              value={s.target ?? ""}
              onChange={(e) => {
                const next = [...secrets]
                next[i] = { ...s, target: e.target.value || undefined }
                set({ secrets: next })
              }}
            />
            <Button
              variant="transparent"
              size="small"
              onClick={() => set({ secrets: secrets.filter((_, j) => j !== i) })}
            >
              <Trash />
            </Button>
          </div>
        ))}
        <datalist id="canvas-secret-options">
          {secretNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>

      {/* Commande (override de l'entrypoint) */}
      <div>
        <Label size="small">Commande (optionnel)</Label>
        <Input
          value={(config.cmd ?? []).join(" ")}
          onChange={(e) =>
            set({ cmd: e.target.value.trim() ? e.target.value.trim().split(/\s+/) : undefined })
          }
          placeholder="node server.js"
        />
      </div>

      {/* Healthcheck */}
      <div>
        <Label size="small">Healthcheck (commande de test, optionnel)</Label>
        <Input
          value={(config.healthcheck?.test ?? []).filter((t) => t !== "CMD-SHELL" && t !== "CMD").join(" ")}
          onChange={(e) => {
            const parts = e.target.value.trim()
            set({
              healthcheck: parts
                ? {
                    test: ["CMD-SHELL", parts],
                    intervalSec: config.healthcheck?.intervalSec ?? 30,
                    timeoutSec: config.healthcheck?.timeoutSec ?? 10,
                    retries: config.healthcheck?.retries ?? 3,
                    startPeriodSec: config.healthcheck?.startPeriodSec ?? 0,
                  }
                : undefined,
            })
          }}
          placeholder="curl -f http://localhost/ || exit 1"
        />
      </div>

      {/* Ressources */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label size="small">Mémoire (Mo)</Label>
          <Input
            type="number"
            value={config.resources?.memMb ?? ""}
            onChange={(e) =>
              set({
                resources: {
                  ...config.resources,
                  memMb: e.target.value ? Number(e.target.value) : undefined,
                },
              })
            }
            placeholder="512"
          />
        </div>
        <div>
          <Label size="small">CPU</Label>
          <Input
            type="number"
            step="0.1"
            value={config.resources?.cpus ?? ""}
            onChange={(e) =>
              set({
                resources: {
                  ...config.resources,
                  cpus: e.target.value ? Number(e.target.value) : undefined,
                },
              })
            }
            placeholder="0.5"
          />
        </div>
      </div>

      {/* Auto-scaling (non natif Swarm — géré par le job auto-scaler de l'outil) */}
      <div className="rounded-lg border border-ui-border-base p-3">
        <div className="flex items-center justify-between">
          <div>
            <Label size="small">Auto-scaling</Label>
            <Text size="xsmall" className="text-ui-fg-muted">
              Ajuste les replicas selon le CPU (Swarm ne le fait pas seul).
            </Text>
          </div>
          <Switch
            checked={config.autoscale?.enabled ?? false}
            onCheckedChange={(checked) =>
              set({
                autoscale: {
                  enabled: checked,
                  minReplicas: config.autoscale?.minReplicas ?? Math.max(1, config.replicas ?? 1),
                  maxReplicas: config.autoscale?.maxReplicas ?? Math.max(3, config.replicas ?? 1),
                  scaleUpCpuPct: config.autoscale?.scaleUpCpuPct ?? 75,
                  scaleDownCpuPct: config.autoscale?.scaleDownCpuPct ?? 25,
                },
              })
            }
          />
        </div>

        {config.autoscale?.enabled && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <Label size="small">Replicas min</Label>
              <Input
                type="number"
                min={1}
                value={config.autoscale.minReplicas}
                onChange={(e) =>
                  set({ autoscale: { ...config.autoscale!, minReplicas: Number(e.target.value) } })
                }
              />
            </div>
            <div>
              <Label size="small">Replicas max</Label>
              <Input
                type="number"
                min={1}
                value={config.autoscale.maxReplicas}
                onChange={(e) =>
                  set({ autoscale: { ...config.autoscale!, maxReplicas: Number(e.target.value) } })
                }
              />
            </div>
            <div>
              <Label size="small">Scale up si CPU ≥ (%)</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={config.autoscale.scaleUpCpuPct}
                onChange={(e) =>
                  set({ autoscale: { ...config.autoscale!, scaleUpCpuPct: Number(e.target.value) } })
                }
              />
            </div>
            <div>
              <Label size="small">Scale down si CPU ≤ (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={config.autoscale.scaleDownCpuPct}
                onChange={(e) =>
                  set({
                    autoscale: { ...config.autoscale!, scaleDownCpuPct: Number(e.target.value) },
                  })
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
