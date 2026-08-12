import {
  caddyAdmin,
  resolveServerName,
  getSystemAdminUrl,
} from "../../lib/caddy-admin";
import { getDefaultCluster } from '../docker-engine/client';
import { prisma } from '../../lib/prisma';



/**
 * Appliquons le domaine systeme (le panel lui-meme, pas un projet utilisateur)
 * aupres de Caddy : 3 routes host-spécifique (api, ws, web), inserees avant
 * les routes catch-all du Caddyfile de base (qui n'ont pas de host et
 * matcheraient sinon en premier, quel que soit le domaine). Idempotent, sans
 * redemarrage de Caddy
 */

//Ids fixes, car il n'existe qu'un seul domaine systeme possible a la fois.

const API_ROUTE_ID  = "hullbay-system-api"
const WS_ROUTE_ID   = "hullbay-system-ws"
const WEB_ROUTE_ID = "hullbay-system-web"

async function systemAdminUrl(): Promise<string> {
  return getSystemAdminUrl();
}

/**
 * S'assurer que le serveur ecoute bien sur le port 443 en plus de sont port existant
 * indispensable pour que Let's Encrypt puisse valider/déliver un certificat sur un
 * domaine ajouté.
 */

async function ensureListensOn443(adminUrl: string, server: string): Promise<void> {
    const res = await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}`)
    let cfg: { listen?: string[] } = {}
    if (res.ok) {
        try {
            cfg = JSON.parse(res.body)
        } catch {
            cfg = {}
        }
    }
    const listen = new Set(cfg.listen ?? [])
    if (listen.has(":443")) return
    listen.add(":443")
    await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}/listen`, "PATCH", [...listen])
}

export async function applyDomainToCaddy(domain: string): Promise<void> {
    const adminUrl = await systemAdminUrl()
    const server = await resolveServerName(adminUrl)

    await ensureListensOn443(adminUrl, server)

    /**
     * Nettoie les routes existantes (rejouable sans erreur, et gere aussi le cas ou
     * l'utilisateur change de domaine: les Ids fixes, donc l'ancien domaine est
     * bien remplacer et non duplique).
     */

    await caddyAdmin(adminUrl, `/id/${API_ROUTE_ID}`, "DELETE").catch(() => { })
    await caddyAdmin(adminUrl, `/id/${WS_ROUTE_ID}`, "DELETE").catch(() => { })
    await caddyAdmin(adminUrl, `/id/${WEB_ROUTE_ID}`, "DELETE").catch(() => { })

    /**
     * Chaque insertion se fait a l'index 0, ce qui repousse les precedente d'un cran
     * Pour obtenir l'ordre final [api, ws, web, ...routes de base], on insere donc l'ordre
     * inverse: web d'abord, puis ws, puis api en dernier. web doit rester apres api/ws 
     * sinon il intercepterait aussi /api/* et /ws* avant qu'elles ne soient evaluees.
     */

    const webRes = await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}/routes/0`, "PUT", {
        "@id": WEB_ROUTE_ID,
        match: [{ host: [domain] }],
        Handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "web:80" }]}],
    })
    if (!webRes.ok) throw new Error(`Caddy: route web échouée (${webRes.status})`)
    
    const wsRes = await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}/routes/0`, "PUT", {
        "@id": WS_ROUTE_ID,
        match: [{ host: [domain], path: ["/ws*"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "api:4000" }] }],
    })
    if (!wsRes.ok) throw new Error(`Caddy: route ws échouée (${wsRes.status})`)
    
    const apiRes = await caddyAdmin(adminUrl, `/config/apps/http/servers/${server}/routes/0`, "PUT",{
        "@id": API_ROUTE_ID,
        match: [{ host: [domain], path: ["/api/*"] }],
        handle: [
          { handler: "reverse_proxy", upstreams: [{ dial: "api:4000" }] },
        ],
      },
    );
    if (!apiRes.ok) throw new Error(`Caddy: route api échouée (${apiRes.status})`);
}