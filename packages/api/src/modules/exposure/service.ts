import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { GatewayConfig } from "@hullbayred"

/**
 * Module exposure : pilote le reverse proxy Caddy via son API d'admin pour
 * exposer un conteneur sur internet (nœud "gateway"). HTTPS automatique géré
 * par Caddy (Let's Encrypt) sur les vrais domaines.
 *
 * On utilise l'API d'admin Caddy (http://localhost:2019) avec des routes
 * identifiées par @id = "boz-<projectSlug>-<nodeName>" pour pouvoir les
 * mettre à jour / supprimer de façon idempotente.
 */

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL || "http://localhost:2019"

function routeId(projectSlug: string, nodeName: string): string {
  return `boz-${projectSlug}-${nodeName}`
}

/** Forme partielle de la config http renvoyée par l'admin Caddy. */
type CaddyServers = Record<
  string,
  { listen?: string[]; routes?: unknown[]; automatic_https?: { skip?: string[] } }
>

type AdminResponse = { ok: boolean; status: number; body: string }

/**
 * Appel à l'API d'admin Caddy via le module `http` natif de Node (PAS `fetch`).
 *
 * RAISON : `fetch` (undici) ajoute automatiquement l'en-tête `Sec-Fetch-Mode: cors`,
 * que Caddy 2 interprète comme une requête cross-origin et REJETTE en 403 (protection
 * anti-DNS-rebinding de l'API admin). Le client `http` natif n'envoie pas cet en-tête
 * (comme curl) -> l'admin répond normalement. Aucune config Caddy à relâcher.
 */
function caddyAdmin(path: string, method = "GET", jsonBody?: unknown): Promise<AdminResponse> {
  const url = new URL(`${CADDY_ADMIN}${path}`)
  const isHttps = url.protocol === "https:"
  const requester = isHttps ? httpsRequest : httpRequest
  const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined

  return new Promise<AdminResponse>((resolve, reject) => {
    const req = requester(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let body = ""
        res.on("data", (c) => (body += c))
        res.on("end", () =>
          resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body })
        )
      }
    )
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export class ExposureService {
  /**
   * Résout le NOM réel du serveur HTTP Caddy dans lequel insérer les routes.
   *
   * On NE code PAS `srv0` en dur : le nom généré par l'adaptateur Caddyfile suit
   * un schéma `srvX` non garanti dès qu'il y a plusieurs sites/listeners (limite
   * connue de Caddy, issue #5322). On interroge donc l'admin et on choisit le
   * serveur qui écoute sur le port public (80/443), avec repli sur le 1er serveur.
   */
  private async resolveServerName(): Promise<string> {
    const res = await caddyAdmin(`/config/apps/http/servers`)
    if (!res.ok) {
      throw new Error(`Caddy: lecture des serveurs impossible (${res.status})`)
    }
    let servers: CaddyServers = {}
    try {
      servers = JSON.parse(res.body) as CaddyServers
    } catch {
      servers = {}
    }
    const names = Object.keys(servers ?? {})
    if (names.length === 0) {
      throw new Error(
        "Caddy: aucun serveur HTTP configuré (le Caddyfile de l'ops-panel n'est pas chargé ?)"
      )
    }
    // Préfère le serveur qui publie le trafic public (port 80 ou 443).
    const onPublicPort = names.find((n) =>
      (servers[n]?.listen ?? []).some((l) => l.endsWith(":80") || l.endsWith(":443"))
    )
    return onPublicPort ?? names[0]!
  }

  /**
   * Active/désactive le HTTPS automatique de Caddy POUR UN HÔTE donné, via
   * `automatic_https.skip` du serveur (levier officiel Caddy, par hôte).
   *
   * RAISON (Bug B) : auto_https est adaptatif. Dès qu'une route matche un `host`
   * nommé, Caddy considère ce site « à sécuriser » et bascule le listener en TLS
   * — même quand le serveur n'écoute qu'en HTTP (port 8080) : toute requête HTTP
   * reçoit alors « Client sent an HTTP request to an HTTPS server ». On NE désactive
   * PAS auto_https globalement (Let's Encrypt doit rester actif pour les vrais
   * domaines de prod, `tls:true`) : on exclut SEULEMENT les hôtes en `tls:false`
   * (domaine interne / test) de la gestion HTTPS, qui restent donc servis en clair.
   */
  private async setHttpsSkip(
    server: string,
    domain: string,
    skip: boolean
  ): Promise<void> {
    const res = await caddyAdmin(`/config/apps/http/servers/${server}`)
    if (!res.ok) return
    let cfg: { automatic_https?: { skip?: string[] } } = {}
    try {
      cfg = JSON.parse(res.body)
    } catch {
      cfg = {}
    }
    const current = new Set(cfg.automatic_https?.skip ?? [])
    if (skip) current.add(domain)
    else current.delete(domain)
    // Écrit la liste `skip` (idempotent). PUT sur le sous-chemin remplace la valeur.
    await caddyAdmin(
      `/config/apps/http/servers/${server}/automatic_https/skip`,
      "PUT",
      [...current]
    )
  }

  /**
   * Ajoute (ou remplace) une route Caddy : domaine -> conteneur cible:port.
   * `upstream` est le nom du conteneur Docker (résolu via le réseau Docker que
   * Caddy doit partager) suivi du port cible.
   */
  async upsertRoute(
    projectSlug: string,
    nodeName: string,
    config: GatewayConfig,
    upstreamHost: string
  ): Promise<void> {
    const id = routeId(projectSlug, nodeName)
    const route = {
      "@id": id,
      match: [{ host: [config.domain] }],
      handle: [
        {
          handler: "reverse_proxy",
          upstreams: [{ dial: `${upstreamHost}:${config.targetPort}` }],
        },
      ],
    }

    // Supprime l'éventuelle route existante (idempotence) puis ré-ajoute, dans le
    // serveur réellement présent (résolu dynamiquement, pas un `srv0` codé en dur).
    await this.deleteRoute(projectSlug, nodeName).catch(() => {})
    const server = await this.resolveServerName()
    // tls:false (domaine interne/test) -> exclure du HTTPS auto ; tls:true -> HTTPS auto.
    await this.setHttpsSkip(server, config.domain, config.tls === false)
    // INSÈRE EN TÊTE (index 0), PAS en fin de liste. Le serveur de l'ops-panel se
    // termine par une route catch-all (le SPA web, `reverse_proxy web:80`, sans
    // matcher) qui intercepte TOUTES les requêtes. Une route passerelle ajoutée
    // APRÈS ne serait jamais atteinte (le catch-all matche d'abord) -> 502 « lookup
    // web ». On l'insère donc avant le catch-all via le sous-chemin .../routes/0.
    const res = await caddyAdmin(
      `/config/apps/http/servers/${server}/routes/0`,
      "PUT",
      route
    )
    if (!res.ok) {
      throw new Error(`Caddy upsert route ${id} a échoué (${res.status})`)
    }
  }

  /** Supprime une route Caddy par son @id. Tolérant si absente. */
  async deleteRoute(projectSlug: string, nodeName: string): Promise<void> {
    const id = routeId(projectSlug, nodeName)
    await caddyAdmin(`/id/${id}`, "DELETE")
  }
}

export const exposureService = new ExposureService()
