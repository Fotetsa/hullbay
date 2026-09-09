import type { ReactNode } from "react"
import { Badge, Button, Container, Heading, Text, clx } from "@medusajs/ui"
import {
  ArrowUpRightMini, Beaker, CheckCircle, ChevronDown, ChevronUpMini,
  CloudArrowDown, DocumentSeries, Layers3, Tag,
} from "@medusajs/icons"
import { useTranslation } from "react-i18next"
import type { UpdateRelease } from "../../lib/api"
import { EmptyState, releaseType } from "./updatesShared"

/** Comparaison semver légère côté web : vrai si `a` est plus récent que `b`. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n))
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/** Mini-rendu markdown des notes de version (titres, listes, texte) — sans dépendance. */
function Notes({ text, clamp = false, t }: { text: string; clamp?: boolean; t: (k: string) => string }) {
  if (!text.trim()) {
    return <Text size="small" className="text-ui-fg-muted">{t("updates.versions.noNotes")}</Text>
  }
  // Retire les références issues/PR (#123) et les liens issues/pulls/commits.
  const stripRefs = (s: string) =>
    s
      .replace(/\[([^\]]*)\]\((https?:\/\/[^)]*(?:\/issues\/|\/pull\/|\/commit\/|\/compare\/)[^)]*)\)/gi, "")
      .replace(/https?:\/\/[^\s)]*?(?:\/issues\/|\/pull\/|\/commit\/|\/compare\/)[^\s)]*/gi, "")
      .replace(/\[([^\]]*)\]\(([^)]*)\)/gi, "$1")
      .replace(/#\d+\b/gi, "")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()
  const out: ReactNode[] = []
  let list: string[] = []
  const flush = (key: string) => {
    if (list.length) {
      out.push(
        <ul key={key} className="mb-2 mt-1 list-disc pl-5">
          {list.map((item, i) => (
            <li key={i} className="text-sm text-ui-fg-base">{stripRefs(item.replace(/^[-*]\s+/, ""))}</li>
          ))}
        </ul>
      )
      list = []
    }
  }
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    if (line.startsWith("- ") || line.startsWith("* ")) {
      list.push(line)
    } else if (/^#{1,3}\s/.test(line)) {
      flush(`h-${i}`)
      out.push(
        <Text key={i} size="small" weight="plus" className="mt-2">
          {stripRefs(line.replace(/^#{1,3}\s+/, ""))}
        </Text>
      )
    } else {
      flush(`l-${i}`)
      out.push(
        <Text key={`${i}-t`} size="small" className="text-ui-fg-subtle">
          {stripRefs(line.replace(/\*\*(.+?)\*\*/g, "$1"))}
        </Text>
      )
    }
  })
  flush("end")
  return <div className={clx(clamp && "line-clamp-3")}>{out}</div>
}

const RELEASE_FILTERS = [
  { value: "all", labelKey: "updates.versions.filter.all", icon: Layers3 },
  { value: "stable", labelKey: "updates.versions.filter.stable", icon: CheckCircle },
  { value: "beta", labelKey: "updates.versions.filter.beta", icon: Beaker },
  { value: "rc", labelKey: "updates.versions.filter.rc", icon: Tag },
] as const

export type ReleaseFilter = (typeof RELEASE_FILTERS)[number]["value"]

/**
 * Carte « Versions publiées » : liste des releases GitHub des deux canaux, avec
 * filtre local Tous/Stable/Beta et installation d'une version intermédiaire.
 */
export function VersionsTab({
  releases,
  loading,
  filter,
  onFilterChange,
  expandedTag,
  onToggle,
  currentVersion,
  running,
  onInstall,
}: {
  releases: UpdateRelease[]
  loading: boolean
  filter: ReleaseFilter
  onFilterChange: (f: ReleaseFilter) => void
  expandedTag: string | null
  onToggle: (tag: string) => void
  currentVersion: string
  running: boolean
  onInstall: (version: string) => void
}) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="updates-releases-title">
      <Container className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <Heading level="h3" id="updates-releases-title">{t("updates.versions.title")}</Heading>
          <div
            role="group"
            aria-label={t("updates.versions.filterAria")}
            className="flex w-full flex-wrap rounded-md border border-ui-border-base bg-ui-bg-subtle p-0.5 sm:w-auto sm:flex-nowrap"
          >
            {RELEASE_FILTERS.map((f) => {
              const active = filter === f.value
              const Icon = f.icon
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onFilterChange(f.value)}
                  className={clx(
                    "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors sm:flex-none",
                    active
                      ? "bg-ui-button-inverted text-white"
                      : "text-ui-fg-muted hover:text-ui-fg-base",
                  )}
                >
                  <Icon />
                  {t(f.labelKey)}
                </button>
              )
            })}
          </div>
        </div>
        {loading ? (
          <Text size="small" className="text-ui-fg-muted">{t("updates.versions.loading")}</Text>
        ) : releases.length === 0 ? (
          <EmptyState
            icon={DocumentSeries}
            title={t("updates.versions.empty.title")}
            hint={
              filter === "all"
                ? t("updates.versions.empty.all")
                : filter === "rc"
                  ? t("updates.versions.empty.rc")
                  : filter === "beta"
                    ? t("updates.versions.empty.beta")
                    : t("updates.versions.empty.stable")
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {releases.map((r, i) => {
              const expanded = expandedTag === r.tag
              const installable = isNewer(r.version, currentVersion)
              const type = releaseType(r)
              return (
                <li
                  key={r.tag}
                  className="flex flex-col gap-3 rounded-lg border border-ui-border-base bg-ui-bg-base p-4 sm:p-5"
                >
                  {/* Entête : version + badge + date */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-base font-medium text-ui-fg-base">
                        {r.version}
                      </span>
                      <Badge
                        color={type === "stable" ? "green" : type === "rc" ? "blue" : "purple"}
                        size="small"
                        className="gap-x-1"
                      >
                        {type === "stable" ? <CheckCircle /> : type === "rc" ? <Tag /> : <Beaker />}
                        {t(`updates.versions.badge.${type}`)}
                      </Badge>
                      {i === 0 && <Badge color="blue" size="small">{t("updates.versions.latest")}</Badge>}
                    </div>
                    <span className="text-xs text-ui-fg-muted">
                      {r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : ""}
                    </span>
                  </div>

                  {/* Notes de version */}
                  <div>
                    <Notes text={r.notes} clamp={!expanded} t={t} />
                  </div>

                  {/* Actions : installer / GitHub / plus de détails */}
                  <div className="mt-auto flex flex-col gap-2 border-t border-ui-border-base pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-2">
                      {installable && (
                        <Button
                          variant="secondary"
                          size="small"
                          className="w-full sm:w-auto"
                          disabled={running}
                          onClick={() => onInstall(r.version)}
                        >
                          <CloudArrowDown />
                          {t("updates.versions.install")}
                        </Button>
                      )}
                      {r.url ? (
                        <Button
                          variant="secondary"
                          size="small"
                          asChild
                          className="w-full sm:w-auto"
                        >
                          <a href={r.url} target="_blank" rel="noreferrer">
                            <ArrowUpRightMini />
                            {t("updates.versions.viewOnGithub")}
                          </a>
                        </Button>
                      ) : (
                        <span className="text-xs text-ui-fg-muted">{t("updates.versions.internalSource")}</span>
                      )}
                    </div>
                    <Button
                      variant="transparent"
                      size="small"
                      className="w-full sm:w-auto"
                      onClick={() => onToggle(r.tag)}
                    >
                      {expanded ? <ChevronUpMini /> : <ChevronDown />}
                      {expanded ? t("updates.versions.lessDetails") : t("updates.versions.moreDetails")}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Container>
    </section>
  )
}