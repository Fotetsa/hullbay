import { useState, useEffect, type ChangeEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button, Heading, Input, Label, Text, Badge, Select, Textarea } from "@medusajs/ui"
import { Plus, Trash, Key } from "@medusajs/icons"
import { api } from "../lib/api"
import { useMutationToast } from "../lib/useMutationToast"
import { useConfirmDelete } from "../lib/useConfirmDelete"
import { PageHeader, PageContainer } from "../components/PageHeader"
import { ListContainer, ListRow } from "../components/ListContainer"
import { ActionMenu } from "../components/ActionMenu"
import { EmptyState } from "../components/EmptyState"
import { useTranslation } from "react-i18next"
import { AppDrawer } from "../components/AppDrawer"
import {
  isAllowedSecretImport,
  isValidSecretName,
  normalizeSecretName,
  parseEnvContent,
  type ParsedEnvEntry,
} from "../lib/envParser"

type SecretMode = "manual" | "paste"

/**
 * Gestion des Docker Secrets : valeurs sensibles stockées HORS labels/env.
 * La valeur est write-only (jamais réaffichée). Référencée par nom dans la config
 * d'un conteneur (montée en /run/secrets/<nom>). Swarm la chiffre au repos.
 */
export function SecretsPage() {
  const { t } = useTranslation()

  const { data: clusters } = useQuery({ queryKey: ["clusters"], queryFn: api.listClusters })
  const [selectedClusterId, setSelectedClusterId] = useState<string>("")

  useEffect(() => {
    if (!selectedClusterId && clusters?.length) {
      const def = clusters.find((c) => c.isDefault)
      setSelectedClusterId(def?.id ?? clusters[0].id)
    }
  }, [clusters, selectedClusterId])

  const { data: secrets } = useQuery({
    queryKey: ["secrets", selectedClusterId],
    queryFn: () => api.listSecrets(selectedClusterId),
    enabled: Boolean(selectedClusterId),
  })

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mode, setMode] = useState<SecretMode>("manual")
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [pasteContent, setPasteContent] = useState("")
  const [parsedEntries, setParsedEntries] = useState<ParsedEnvEntry[]>([])
  const [parseError, setParseError] = useState("")

  const handleFileImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!isAllowedSecretImport(file.name)) {
      setParseError("Type de fichier non autorisé. Utilise .env, .txt ou .md uniquement.")
      event.target.value = ""
      return
    }

    try {
      const text = await file.text()
      const parsed = parseEnvContent(text)
      if (!parsed.length) {
        setParseError("Aucune variable valide détectée dans le fichier importé.")
        setParsedEntries([])
        event.target.value = ""
        return
      }

      const invalid = parsed.filter((entry) => !isValidSecretName(entry.key))
      if (invalid.length) {
        setParsedEntries(parsed)
        setParseError(
          `Variables ignorées : ${invalid
            .slice(0, 5)
            .map((entry) => entry.key)
            .join(", ")} ${invalid.length > 5 ? "..." : ""}`,
        )
        event.target.value = ""
        return
      }

      setParsedEntries(parsed)
      setParseError("")
      setPasteContent(text)
    } catch {
      setParseError("Impossible de lire ce fichier.")
    } finally {
      event.target.value = ""
    }
  }

  const resetDrawer = () => {
    setDrawerOpen(false)
    setMode("manual")
    setName("")
    setValue("")
    setPasteContent("")
    setParsedEntries([])
    setParseError("")
  }

  const handleParsePaste = () => {
    const parsed = parseEnvContent(pasteContent)
    if (!parsed.length) {
      setParseError("Aucune variable détectée dans le contenu collé.")
      setParsedEntries([])
      return
    }

    const invalid = parsed.filter((entry) => !isValidSecretName(entry.key))
    if (invalid.length) {
      setParsedEntries(parsed)
      setParseError(
        `Variables ignorées : ${invalid
          .slice(0, 5)
          .map((entry) => entry.key)
          .join(", ")} ${invalid.length > 5 ? "..." : ""}`,
      )
      return
    }

    setParsedEntries(parsed)
    setParseError("")
  }

  const manualNameError = normalizeSecretName(name) && !isValidSecretName(name)
    ? "Nom invalide : seuls lettres, chiffres, . _ et - sont autorisés, aucun espace ni .. ."
    : ""

  const updateParsedEntry = (index: number, key: string, nextValue: string) => {
    setParsedEntries((current) =>
      current.map((entry, idx) =>
        idx === index ? { ...entry, key, value: nextValue } : entry,
      ),
    )
  }

  const save = useMutationToast({
    mutationFn: async () => {
      if (mode === "paste") {
        const unique = new Map<string, string>()
        for (const entry of parsedEntries) {
          const trimmedKey = normalizeSecretName(entry.key)
          const trimmedVal = entry.value.trim()
          if (trimmedKey && isValidSecretName(trimmedKey) && trimmedVal) {
            unique.set(trimmedKey, trimmedVal)
          }
        }

        const validEntries = Array.from(unique.entries()).map(([name, value]) => ({
          name,
          value,
        }))

        if (!validEntries.length) {
          throw new Error("Aucune variable de secret valide à enregistrer")
        }

        return api.setSecretBatch(selectedClusterId, validEntries)
      }

      const trimmedName = normalizeSecretName(name)
      if (!trimmedName || !isValidSecretName(trimmedName)) {
        throw new Error("Nom de secret invalide")
      }

      return api.setSecretBatch(selectedClusterId, [{ name: trimmedName, value: value.trim() }])
    },
    success: t("secrets.toast.saveSuccess"),
    invalidate: [["secrets", selectedClusterId]],
    onSuccess: () => {
      resetDrawer()
    },
  })

  const removeSecret = useConfirmDelete<string>({
    mutationFn: (n) => api.deleteSecret(selectedClusterId, n),
    success: t("secrets.toast.removeSuccess"),
    invalidate: [["secrets", selectedClusterId]],
    confirm: (n) => ({
      title: t("secrets.deleteConfirm.title"),
      description: t("secrets.deleteConfirm.description", { name: n }),
    }),
  })

  return (
    <PageContainer size="2xl">
      <PageHeader title={t("secrets.pageTitle")} />

      <div className="mb-4">
        <Label size="small">{t("secrets.clusterLabel")}</Label>
        <Select value={selectedClusterId} onValueChange={setSelectedClusterId}>
          <Select.Trigger>
            <Select.Value placeholder={t("secrets.clusterPlaceholder")} />
          </Select.Trigger>
          <Select.Content>
            {clusters?.map((c) => (
              <Select.Item key={c.id} value={c.id}>{c.name}</Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>

      <div className="mb-4 flex justify-end">
        <Button onClick={() => setDrawerOpen(true)} disabled={!selectedClusterId}>
          <Plus /> Ajouter un secret
        </Button>
      </div>

      <div className="mb-6">
        <ListContainer
          title={t("secrets.list.title")}
          subtitle={secrets ? t("secrets.list.subtitle", { count: secrets.length }) : undefined}
          isEmpty={secrets?.length === 0}
          empty={
            <EmptyState
              icon={Key}
              title={t("secrets.empty.title")}
              description={t("secrets.empty.description")}
            />
          }
        >
          {secrets?.map((s) => (
            <ListRow key={s.id}>
              <div className="flex items-center gap-2">
                <Key className="text-ui-fg-muted" />
                <Heading level="h3">{s.name}</Heading>
                <Badge size="2xsmall" color="green">
                  {t("secrets.badge.encrypted")}
                </Badge>
              </div>
              <ActionMenu
                groups={[
                  {
                    actions: [
                      {
                        label: t("secrets.actions.delete"),
                        icon: <Trash />,
                        variant: "danger",
                        onClick: () => removeSecret(s.name),
                      },
                    ],
                  },
                ]}
              />
            </ListRow>
          ))}
        </ListContainer>
      </div>

      <AppDrawer
        isOpen={drawerOpen}
        onClose={() => {
          resetDrawer()
        }}
        title="Ajouter un secret"
        description="Ajoutez un secret à la main ou collez directement un fichier .env."
        onSave={() => save.mutate()}
        saveLabel="Enregistrer"
        isLoading={save.isPending}
        saveDisabled={
          mode === "manual"
            ? !normalizeSecretName(name) || !value.trim() || !selectedClusterId || !!manualNameError
            : !parsedEntries.some((entry) => isValidSecretName(entry.key) && entry.value.trim()) ||
              !selectedClusterId
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "manual" ? "primary" : "secondary"}
              onClick={() => setMode("manual")}
            >
              Valeur par valeur
            </Button>
            <Button
              type="button"
              variant={mode === "paste" ? "primary" : "secondary"}
              onClick={() => setMode("paste")}
            >
              Coller un .env
            </Button>
          </div>

          {mode === "manual" ? (
            <>
              <div>
                <Label size="small">{t("secrets.form.nameLabel")}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("secrets.form.namePlaceholder")}
                  aria-invalid={Boolean(manualNameError)}
                />
                <Text size="xsmall" className={manualNameError ? "mt-1 text-ui-fg-error" : "mt-1 text-ui-fg-muted"}>
                  {manualNameError || t("secrets.form.nameHint")}
                </Text>
              </div>

              <div>
                <Label size="small">{t("secrets.form.valueLabel")}</Label>
                <Input
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t("secrets.form.valuePlaceholder")}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <Label size="small">Contenu .env</Label>
                <Textarea
                  value={pasteContent}
                  onChange={(e) => setPasteContent(e.target.value)}
                  placeholder={"DB_HOST=localhost\nDB_PORT=5432\nTOKEN=\"abc\""}
                  className="min-h-[180px]"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={handleParsePaste}>
                  Parser le contenu
                </Button>

                <label className="inline-flex cursor-pointer items-center rounded-md border border-ui-border-base px-3 py-2 text-sm">
                  <input
                    type="file"
                    accept=".env,.txt,.md,text/plain"
                    className="hidden"
                    onChange={handleFileImport}
                  />
                  Importer un fichier
                </label>
              </div>

              {parseError ? (
                <Text size="small" className="text-ui-fg-error">
                  {parseError}
                </Text>
              ) : null}

              {parsedEntries.length > 0 ? (
                <div className="space-y-3">
                  <Text size="small" className="text-ui-fg-muted">
                    {parsedEntries.length} variable(s) détectée(s)
                  </Text>

                  <div className="max-h-64 overflow-y-auto rounded-md border border-ui-border-base bg-ui-bg-subtle p-2">
                    <div className="space-y-2">
                      {parsedEntries.map((entry, index) => {
                        const invalidKey = !!entry.key && !isValidSecretName(entry.key)
                        return (
                          <div key={`${entry.key}-${index}`} className="space-y-1 rounded-md bg-ui-bg-base p-2">
                            <div className="grid grid-cols-[1fr_1fr] gap-2">
                              <Input
                                value={entry.key}
                                onChange={(e) => updateParsedEntry(index, e.target.value, entry.value)}
                                placeholder="NOM_DE_LA_VARIABLE"
                                aria-invalid={invalidKey}
                              />
                              <Input
                                type="password"
                                value={entry.value}
                                onChange={(e) => updateParsedEntry(index, entry.key, e.target.value)}
                                placeholder="Valeur"
                              />
                            </div>
                            {invalidKey ? (
                              <Text size="xsmall" className="text-ui-fg-error">
                                Nom invalide : seuls lettres, chiffres, . _ et - sont autorisés.
                              </Text>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </AppDrawer>
    </PageContainer>
  )
}