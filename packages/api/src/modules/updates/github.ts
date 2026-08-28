/**
 * GitHubReleasesService — lit les releases du dépôt hullbay pour détecter les
 * mises à jour disponibles (stable vs beta/pre-release).
 *
 * - Lecture publique GitHub : fonctionne SANS token (rate-limit 60 req/h par IP).
 * - GITHUB_TOKEN (env) : optionnel, augmente le quota et rend les checks fiables.
 * - GITHUB_OWNER / GITHUB_REPO : défauts GHCR_OWNER (env déjà utilisé pour les
 *   images) / "hullbay".
 * - GITHUB_API_URL : base de l'API (défaut https://api.github.com). Permet de
 *   pointer vers un miroir/mock (tests hors-ligne) sans toucher au code.
 *
 * Cache mémoire TTL (5 min par défaut) : évite de consommer le quota local sur
 * chaque ouverture de page / poll (60 req/h par IP sans token).
 *   - Clé = canal + limit ; une réponse 403 n'est JAMAIS mise en cache (retry).
 *
 * Parseur semver maison (sans dépendance) : MAJOR.MINOR.PATCH avec pré-release
 * optionnelle. Suffisant pour des tags en `v1.2.3` / `1.2.3` / `1.2.3-beta.1`.
 */

export type GitHubRelease = {
  tag: string
  version: string
  prerelease: boolean
  draft: boolean
  publishedAt: string | null
  url: string
  notes: string
}

/** Canal de distribution : stable (exclut les pre-release) / beta (tout) / all (stable + beta mélangés). */
export type Channel = "stable" | "beta" | "all"

type RawGitHubRelease = {
  tag_name?: string
  prerelease?: boolean
  draft?: boolean
  published_at?: string | null
  html_url?: string
  body?: string | null
}

/** Comparateur semver : > 0 si a > b, 0 si égal, < 0 sinon. "1.2.3" > "1.2.3-beta". */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/)
    if (!match) return null
    const [, major, minor, patch, pre] = match
    return { major: Number(major), minor: Number(minor), patch: Number(patch), pre: pre ?? null }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) {
    // Fallback lexicographique pour les tags non semver (ne casse jamais le tri).
    return a < b ? -1 : a > b ? 1 : 0
  }
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key]
  }
  // Pas de pré-release = plus récent qu'une pré-release de même version (semver).
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return comparePrerelease(pa.pre, pb.pre)
}

/**
 * Compare deux pré-releases semver, identifiant par identifiant (séparés par
 * des points). Règles : numériques comparés numériquement (beta.10 > beta.2),
 * numérique < alphanumérique, alphanumériques lexicographiquement, plus
 * d'identifiants = plus récent (alpha < alpha.1).
 */
function comparePrerelease(a: string, b: string): number {
  const ai = a.split(".")
  const bi = b.split(".")
  const len = Math.min(ai.length, bi.length)
  for (let i = 0; i < len; i++) {
    const x = ai[i]!
    const y = bi[i]!
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const diff = BigInt(x) - BigInt(y)
      if (diff > 0n) return 1
      if (diff < 0n) return -1
      continue
    }
    if (xn) return -1 // numérique < alphanumérique (semver)
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return ai.length - bi.length
}

export class GitHubReleasesService {
  private owner: string
  private repo: string
  private token?: string
  private baseUrl: string
  private fetchFn: typeof fetch
  private readonly ttlMs: number
  private cache = new Map<string, { at: number; releases: GitHubRelease[] }>()

  constructor(fetchFn: typeof fetch = fetch, ttlMs = 5 * 60 * 1000) {
    this.owner = process.env.GITHUB_OWNER || process.env.GHCR_OWNER || "fotetsa"
    this.repo = process.env.GITHUB_REPO || "hullbay"
    this.token = process.env.GITHUB_TOKEN
    this.baseUrl = process.env.GITHUB_API_URL || "https://api.github.com"
    this.fetchFn = fetchFn
    this.ttlMs = ttlMs
  }

  /** Normalise un tag en version semver (retire le préfixe `v`). */
  static normalizeTag(tag: string): string {
    return tag.replace(/^v/, "")
  }

  /** Liste les releases du canal demandé, triées par date de publication
   *  décroissante (départage semver). Une pre-release publiée APRÈS une stable
   *  du même numéro (ex. stable 1.2.4 le 08/08 puis beta.6 le 27/08) est donc
   *  considérée plus récente, et "latest" n'annonce plus une stable désuète.
   *  "all" renvoie stable + beta (le filtre pre-release est un client-side). */
  async listReleases(channel: Channel = "stable", limit = 20): Promise<GitHubRelease[]> {
    const key = `${channel}:${limit}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < this.ttlMs) {
      return cached.releases
    }

    const url = `${this.baseUrl}/repos/${this.owner}/${this.repo}/releases?per_page=${limit}`
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "hullbay-ops-panel",
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`

    const res = await this.fetchFn(url, { headers })
    if (!res.ok) {
      throw new Error(
        `GitHub releases ${res.status} : ${res.statusText} (${url})` +
          (res.status === 403 ? " — rate-limit, configure GITHUB_TOKEN" : "")
      )
    }
    const raw = (await res.json()) as RawGitHubRelease[]
    const releases = raw
      .filter((r) => !r.draft)
      .filter((r) => channel !== "stable" || !r.prerelease)
      .map((r) => ({        tag: r.tag_name ?? "",
        version: GitHubReleasesService.normalizeTag(r.tag_name ?? ""),
        prerelease: r.prerelease ?? false,
        draft: r.draft ?? false,
        publishedAt: r.published_at ?? null,
        url: r.html_url ?? "",
        notes: r.body ?? "",
      }))
      .filter((r) => r.tag !== "")
      .sort((a, b) => {
        // Tri principal : date de publication décroissante. Une pre-release
        // récente prime sur une stable plus ancienne du même numéro (semver
        // pur dirait l'inverse) — c'est la release réellement "à jour" qu'on
        // veut en premier. Dates absentes/invalides → les releases, au pire.
        const da = a.publishedAt ? Date.parse(a.publishedAt) : NaN
        const db = b.publishedAt ? Date.parse(b.publishedAt) : NaN
        const sa = Number.isNaN(da) ? -Infinity : da
        const sb = Number.isNaN(db) ? -Infinity : db
        if (sa !== sb) return sb - sa
        // Départage : semver décroissant (stabilité de l'ordre à date égale).
        return compareVersions(b.version, a.version)
      })

    this.cache.set(key, { at: Date.now(), releases })
    return releases
  }

  /** Dernière version disponible sur le canal (null si aucune release). */
  async latest(channel: Channel = "stable"): Promise<GitHubRelease | null> {
    const releases = await this.listReleases(channel, 1)
    return releases[0] ?? null
  }

  /** Vrai si `candidate` est une version plus récente que `current` (semver). */
  isUpdateAvailable(current: string, candidate: string): boolean {
    return compareVersions(candidate, current) > 0
  }
}

/** Singleton partagé (fetch injectable uniquement dans les tests). */
export const githubReleasesService = new GitHubReleasesService()
