import type { GatewayConfig } from "@hullbay/shared"
import { caddyAdmin, resolveServerName } from "../../lib/caddy-admin"
import { prisma } from "../../lib/prisma"

/**
 * Module exposure : pilote le reverse proxy Caddy via son API d'admin pour
 * exposer un conteneur sur internet (nœud "gateway"). HTTPS automatique géré
 * par Caddy (Let's Encrypt) sur les vrais domaines.
 *
 * On utilise l'API d'admin Caddy (http://localhost:2019) avec des routes
 * identifiées par @id = "boz-<projectSlug>-<nodeName>" pour pouvoir les
 * mettre à jour / supprimer de façon idempotente.
 */

function routeId(projectSlug: string, nodeName: string): string {
  return `boz-${projectSlug}-${nodeName}`
}

async function adminUrlForCluster(clusterId: string): Promise<string> {
  const cluster = await prisma.cluster.findUniqueOrThrow({ where: { id: clusterId } })
  return cluster.caddyAdminUrl;
}

export class ExposureService {
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
    adminUrl: string,
    server: string,
    domain: string,
    skip: boolean
  ): Promise<void> {
    const res = await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}`)
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
    await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}/automatic_https/skip`, "PUT", [...current])
  }

  /**
   * Ajoute (ou remplace) une route Caddy : domaine -> conteneur cible:port.
   * `upstream` est le nom du conteneur Docker (résolu via le réseau Docker que
   * Caddy doit partager) suivi du port cible.
   */
  async upsertRoute(
    clusterId: string,
    projectSlug: string,
    nodeName: string,
    config: GatewayConfig,
    upstreamHost: string
  ): Promise<void> {
    const adminUrl = await adminUrlForCluster(clusterId)
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
    await this.deleteRoute(clusterId, projectSlug, nodeName).catch(() => {})
    const server = await resolveServerName(adminUrl)
    // tls:false (domaine interne/test) -> exclure du HTTPS auto ; tls:true -> HTTPS auto.
    await this.setHttpsSkip(adminUrl, server, config.domain, config.tls === false)
    // INSÈRE EN TÊTE (index 0), PAS en fin de liste. Le serveur de l'ops-panel se
    // termine par une route catch-all (le SPA web, `reverse_proxy web:80`, sans
    // matcher) qui intercepte TOUTES les requêtes. Une route passerelle ajoutée
    // APRÈS ne serait jamais atteinte (le catch-all matche d'abord) -> 502 « lookup
    // web ». On l'insère donc avant le catch-all via le sous-chemin .../routes/0.
    const res = await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}/routes/0`, "PUT", route)
    if (!res.ok) {
      throw new Error(`Caddy upsert route ${id} a échoué (${res.status})`)
    }
  }

  /** Supprime une route Caddy par son @id. Tolérant si absente. */
  async deleteRoute(clusterId: string, projectSlug: string, nodeName: string): Promise<void> {
    const adminUrl = await adminUrlForCluster(clusterId)
    const id = routeId(projectSlug, nodeName)
    await caddyAdmin(adminUrl, `/id/${id}`, "DELETE")
  }
}

export const exposureService = new ExposureService()
