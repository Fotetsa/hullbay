import type { ReactNode } from "react"
import { Input, Label, Select, Switch, Text } from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import type { DatabaseConfig, DatabaseEngine, DatabaseMode, DatabaseStorage } from "@hullbay/shared"
import { api } from "../../lib/api"

/**
 * Formulaire de configuration d'un nœud database .
 *
 * Champs (champs avancés conditionnels par moteur) :
 *  - moteur / version explicite (jamais "latest")
 *  - mode (single / HA) + topologie : data-replicas et consensus DECOUPLÉS  ;
 *    le consensus (etcd/Sentinel) n'est présent que pour les moteurs qui en ont.
 *  - stockage (sizeGo informatif + driver + volume externe)
 *  - ressources (CPU/mémoire, optionnel)
 *  - credentials = username + database + RÉFÉRENCE à un Docker Secret (la
 *    valeur du mot de passe n'est JAMAIS saisie ici).
 *  - rétention des données à la suppression (true par défaut).
 *
 * La config est validée par `parseNodeConfig` côté Inspector (même schéma partagé
 * que le backend) avant envoi — pas de schéma front-only.
 */
type Cfg = Partial<DatabaseConfig>

/** Versions par défaut stables + replicas HA autorisés par moteur.
 *  Reflète ENGINE_TOPOLOGY du module database (source backend) — toute dérive
 *  est rejetée au déploiement par validateDatabaseConfig. */
export const ENGINE_DEFAULTS: Record<
  DatabaseEngine,
  { version: string; haReplicas: number[]; hasConsensus: boolean }
> = {
  postgres: { version: "16.3", haReplicas: [3, 5, 7], hasConsensus: true },
  mysql: { version: "8.4", haReplicas: [3, 5], hasConsensus: false },
  mongodb: { version: "7.0", haReplicas: [3, 5], hasConsensus: false },
  redis: { version: "7.4", haReplicas: [2, 3, 4, 5], hasConsensus: true },
}

/** Petite section de formulaire : titre + contenu, cohérente avec l'inspecteur. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Text size="small" weight="plus" className="text-ui-fg-base">
        {title}
      </Text>
      {children}
    </div>
  )
}

export function DatabaseForm({
  config,
  onChange,
  clusterId,
}: {
  config: Cfg
  onChange: (next: Cfg) => void
  clusterId: string
}) {
  const engine = config.engine ?? "postgres"
  const mode = config.mode ?? "single"
  const engineMeta = ENGINE_DEFAULTS[engine]
  const modeChange = (nextMode: DatabaseMode) => {
    const patch: Cfg = { ...config, mode: nextMode }
    if (nextMode === "single") {
      patch.topology = { replicas: 1 }
    } else {
      patch.topology = { replicas: engineMeta.haReplicas[0] }
    }
    onChange(patch)
  }

  const engineChange = (nextEngine: DatabaseEngine) => {
    const nextMeta = ENGINE_DEFAULTS[nextEngine]
    const patch: Cfg = {
      ...config,
      engine: nextEngine,
      version: nextMeta.version,
    }
    // Moteur sans consensus : on dégage un consensusReplicas devenu invalide.
    if (config.topology?.consensusReplicas !== undefined) {
      patch.topology = { ...config.topology, consensusReplicas: undefined }
    }
    onChange(patch)
  }

  const { data: availableSecrets, isLoading: secretsLoading, error: secretsError } = useQuery({
    queryKey: ["secrets", clusterId],
    queryFn: () => api.listSecrets(clusterId),
    enabled: Boolean(clusterId),
    refetchOnMount: "always",
    retry: 1,
  })
  const secretNames = availableSecrets?.map((secret) => secret.name) ?? []

  const set = (patch: Cfg) => onChange({ ...config, ...patch })
  /** Merge partiel du bloc storage — schéma partagé, non modifiable en tant que Partial. */
  const mergeStorage = (patch: Partial<DatabaseStorage>) =>
    set({ storage: { ...config.storage, ...patch } } as Cfg)
  const replicas = config.topology?.replicas ?? (mode === "ha" ? engineMeta.haReplicas[0]! : 1)

  return (
    <div className="flex flex-col gap-4">
      {/* Moteur */}
      <Section title="Moteur">
        <Select value={engine} onValueChange={(v) => engineChange(v as DatabaseEngine)}>
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content className="z-[60]">
            <Select.Item value="postgres">PostgreSQL</Select.Item>
            <Select.Item value="mysql">MySQL</Select.Item>
            <Select.Item value="mongodb">MongoDB</Select.Item>
            <Select.Item value="redis">Redis</Select.Item>
          </Select.Content>
        </Select>
        <Text size="xsmall" className="text-ui-fg-muted">
          PostgreSQL, MySQL, MongoDB et Redis sont tous déployables (single ou HA).
          Le réseau de coordination (etcd / Sentinel) n'apparaît que pour les
          moteurs qui en ont.
        </Text>
      </Section>

      {/* Version */}
      <Section title="Version">
        <Input
          value={config.version ?? ""}
          onChange={(e) => set({ version: e.target.value })}
          placeholder={engineMeta.version}
          aria-invalid={config.version === "latest"}
        />
        <Text size="xsmall" className="text-ui-fg-muted">
          Version explicite — jamais « latest » en production.
        </Text>
      </Section>

      {/* Mode */}
      <Section title="Mode de déploiement">
        <Select value={mode} onValueChange={(v) => modeChange(v as DatabaseMode)}>
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Content className="z-[60]">
            <Select.Item value="single">Simple (1 nœud)</Select.Item>
            <Select.Item value="ha">Haute disponibilité</Select.Item>
          </Select.Content>
        </Select>
      </Section>

      {/* Topologie (data-replicas vs consensus découplés, spec §13) */}
      {mode === "ha" ? (
        <Section title="Topologie HA">
          <div>
            <Label size="small">Membres data</Label>
            <Select
              value={String(replicas)}
              onValueChange={(v) => set({ topology: { ...config.topology, replicas: Number(v) } })}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content className="z-[60]">
                {engineMeta.haReplicas.map((r) => (
                  <Select.Item key={r} value={String(r)}>
                    {r} membres
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
            <Text size="xsmall" className="text-ui-fg-muted">
              Autorise : {engineMeta.haReplicas.join(", ")} (validation stricte au déploiement).
            </Text>
          </div>

          {engineMeta.hasConsensus && (
            <div>
              <Label size="small">Nœuds de consensus (coordination)</Label>
              <Select
                value={config.topology?.consensusReplicas ? String(config.topology.consensusReplicas) : "__auto"}
                onValueChange={(v) =>
                  set({
                    topology: {
                      ...config.topology,
                      consensusReplicas: v === "__auto" ? undefined : Number(v),
                    },
                  })
                }
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content className="z-[60]">
                  <Select.Item value="__auto">Auto (défaut du moteur)</Select.Item>
                  <Select.Item value="3">3</Select.Item>
                  <Select.Item value="5">5</Select.Item>
                </Select.Content>
              </Select>
              <Text size="xsmall" className="text-ui-fg-muted">
                Axe indépendant des membres data (etcd pour PostgreSQL, Sentinel pour Redis).
              </Text>
            </div>
          )}
        </Section>
      ) : (
        <Text size="xsmall" className="text-ui-fg-muted">
          Mode simple : un seul membre data (les replicas sont fixés à 1).
        </Text>
      )}

      {/* Stockage */}
      <Section title="Stockage">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label size="small">Taille (Go, informatif)</Label>
            <Input
              type="number"
              min={1}
              value={config.storage?.sizeGb ?? ""}
              onChange={(e) =>
                mergeStorage({ sizeGb: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="20"
            />
          </div>
          <div>
            <Label size="small">Driver</Label>
            <Input
              value={config.storage?.driver ?? ""}
              onChange={(e) => mergeStorage({ driver: e.target.value })}
              placeholder="local"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Label size="small">Volume externe existant</Label>
          <Switch
            checked={config.storage?.external ?? false}
            onCheckedChange={(c) =>
              mergeStorage({ external: c, externalName: c ? config.storage?.externalName : undefined })
            }
          />
        </div>
        {config.storage?.external && (
          <Input
            value={config.storage?.externalName ?? ""}
            onChange={(e) => mergeStorage({ externalName: e.target.value })}
            placeholder="Nom du volume Docker existant"
          />
        )}
      </Section>

      {/* Ressources */}
      <Section title="Ressources">
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
      </Section>

      {/* Credentials — référence de secret, JAMAIS la valeur (§23) */}
      <Section title="Identifiants">
        <div className="flex flex-col gap-2">
          <div>
            <Label size="small">Utilisateur</Label>
            <Input
              value={config.credentials?.username ?? ""}
              onChange={(e) =>
                set({ credentials: { ...config.credentials!, username: e.target.value } })
              }
              placeholder="app"
            />
          </div>
          <div>
            <Label size="small">Nom de la base</Label>
            <Input
              value={config.credentials?.database ?? ""}
              onChange={(e) =>
                set({ credentials: { ...config.credentials!, database: e.target.value } })
              }
              placeholder="app"
            />
          </div>
          <div>
            <Label size="small">Mot de passe (secret Docker)</Label>
            <Input
              list="canvas-db-secret-options"
              value={config.credentials?.passwordSecretRef ?? ""}
              onChange={(e) => {
                const next = e.target.value
                // Champ vidé → undefined (pas "") : le schéma exige un nom de
                // secret valide ; un nœud sans secret choisi est un état normal.
                set({
                  credentials: {
                    ...config.credentials!,
                    passwordSecretRef: next.length > 0 ? next : undefined,
                  },
                })
              }}
              placeholder="Sélectionne un secret"
            />
            <Text size="xsmall" className="mt-1 text-ui-fg-muted">
              Référence un secret créé dans « Secrets » — la valeur n'est jamais
              stockée dans la config.
              {secretsLoading ? " Chargement…" : ` ${secretNames.length} secret(s) disponible(s)`}
            </Text>
            {secretsError && (
              <Text size="xsmall" className="text-ui-fg-error">
                Impossible de charger les secrets : {secretsError.message}
              </Text>
            )}
            <datalist id="canvas-db-secret-options">
              {secretNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </div>
        </div>
      </Section>

      {/* Rétention (§30) */}
      <div className="flex items-center justify-between">
        <div>
          <Label size="small">Conserver les données à la suppression</Label>
          <Text size="xsmall" className="text-ui-fg-muted">
            Le volume de données survive au destroy (spec §30).
          </Text>
        </div>
        <Switch
          checked={config.retainDataOnDelete ?? true}
          onCheckedChange={(c) => set({ retainDataOnDelete: c })}
        />
      </div>

      {/* Aide à l'édition des credentials (rappel, lecture seule) */}
      <Text size="xsmall" className="text-ui-fg-muted">
        L'URL de connexion est construite au déploiement : l'app dépendante reçoit
        les variables DATABASE_* via le lien conteneur → base.
      </Text>
    </div>
  )
}