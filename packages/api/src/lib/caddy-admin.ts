import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Client HTTP partagé vers l'API admin Caddy (http://caddy:2019), utilise par
 * tous les modules qui pilotent Caddy dynamiquement : exposure (gateways de projets) et settings (domaine systeme). Extrait de exposure/service.ts pour
 * eviter la duplication du comportement stricte et identique de l'original.
 */

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL || "http://localhost:2019";

/** Forme partielle de la config http renvoyée par l'admin Caddy. */
export type CaddyServers = Record<
  string,
  {
    listen?: string[];
    routes?: unknown[];
    automatic_https?: { skip?: string[] };
  }
>;

export type AdminResponse = { ok: boolean; status: number; body: string };

/**
 * Appel à l'API d'admin Caddy via le module `http` natif de Node (PAS `fetch`).
 *
 * RAISON : `fetch` (undici) ajoute automatiquement l'en-tête `Sec-Fetch-Mode: cors`,
 * que Caddy 2 interprète comme une requête cross-origin et REJETTE en 403 (protection
 * anti-DNS-rebinding de l'API admin). Le client `http` natif n'envoie pas cet en-tête
 * (comme curl) -> l'admin répond normalement. Aucune config Caddy à relâcher.
 */
export function caddyAdmin(
  path: string,
  method = "GET",
  jsonBody?: unknown,
): Promise<AdminResponse> {
  const url = new URL(`${CADDY_ADMIN}${path}`);
  const isHttps = url.protocol === "https:";
  const requester = isHttps ? httpsRequest : httpRequest;
  const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;

  return new Promise<AdminResponse>((resolve, reject) => {
    const req = requester(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            ok: (res.statusCode ?? 0) < 400,
            status: res.statusCode ?? 0,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Résout le NOM réel du serveur HTTP Caddy dans lequel insérer les routes.
 *
 * On NE code PAS `srv0` en dur : le nom généré par l'adaptateur Caddyfile suit
 * un schéma `srvX` non garanti dès qu'il y a plusieurs sites/listeners (limite
 * connue de Caddy, issue #5322). On interroge donc l'admin et on choisit le
 * serveur qui écoute sur le port public (80/443), avec repli sur le 1er serveur.
 */
export async function resolveServerName(): Promise<string> {
  const res = await caddyAdmin(`/config/apps/http/servers`);
  if (!res.ok) {
    throw new Error(`Caddy: lecture des serveurs impossible (${res.status})`);
  }
  let servers: CaddyServers = {};
  try {
    servers = JSON.parse(res.body) as CaddyServers;
  } catch {
    servers = {};
  }
  const names = Object.keys(servers ?? {});
  if (names.length === 0) {
    throw new Error(
      "Caddy: aucun serveur HTTP configuré (le Caddyfile de l'ops-panel n'est pas chargé ?)",
    );
  }
  // Préfère le serveur qui publie le trafic public (port 80 ou 443).
  const onPublicPort = names.find((n) =>
    (servers[n]?.listen ?? []).some(
      (l) => l.endsWith(":80") || l.endsWith(":443"),
    ),
  );
  return onPublicPort ?? names[0]!;
}
