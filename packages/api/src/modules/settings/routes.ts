import { FastifyInstance } from "fastify";
import { z } from "zod"
import { parse as parseDomain } from "tldts"
import { settingsService } from "./service";
import { currentUser, type Role as LegacyRole } from "../auth/rbac";
import { requirePermission } from "../authorization/http";
import type { TenantScopedRequest } from "../auth/tenancy/tenant-resolver";
import { eventBus } from "../../lib/event-bus";
import { AuthError } from "../auth/providers/types";

/**
 * Routes des parametres systeme. Lecture, ecriture reserve au owner
 */
const guard = (action: string, legacyMin: LegacyRole = "owner") => ({
  preHandler: requirePermission(action, { legacyMin }),
});

/**
 * Validation du domaine: le format du nom de domaine classique (labels separes par
 * des points, TLD alphabetique >= 2 caracteres). volontairement stricte pour
 * eviter d'envoyer une valeur mal formee a l'api admin Caddy, qui accepterait
 * silencieusement une route inutilisable.
 */

function isValidPublicDomain(value: string): boolean {
    const result = parseDomain(value, { allowPrivateDomains: false })

    return Boolean(result.isIcann && result.hostname === value)
}

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isValidPublicDomain, { message: "nom de domaine invalide" 
});


export async function registerSettingsRoutes(app: FastifyInstance) {
    app.get(
      "/api/settings/domain",
      {
        ...guard("settings.domain.read"),
        schema: {
          tags: ["settings"],
          summary: "Lire le nom de domaine configure (uniquement le owner)",
          security: [{ bearerAuth: [] }],
        },
      },
      async (req) => settingsService.get((req as TenantScopedRequest).tenantId),
    );

    const setBody = z.object({
        domain: domainSchema,
    })

    app.post(
      "/api/settings/domain",
      {
        ...guard("settings.domain.set"),
        schema: {
          body: setBody,
          tags: ["settings"],
          summary: "Définir le nom de domaine (owner uniquement)",
          security: [{ bearerAuth: [] }],
        },
      },
      async (req, reply) => {
        const body = req.body as { domain: string };
        try {
          const reqTenant = (req as TenantScopedRequest).tenantId;
          const result = await settingsService.setDomain(
            body.domain,
            reqTenant,
          );
          await eventBus.emit("settings.domain.set", {
            userId: currentUser(req)?.sub,
            domain: body.domain,
            tenantId: reqTenant,
          });
          return result;
        } catch (err) {
          return reply
            .code(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    );

    // ── WebAuthn / Passkeys (config RP du tenant, publique, lue en base) ──

    app.get(
      "/api/settings/webauthn",
      {
        ...guard("settings.domain.read"),
        schema: {
          tags: ["settings"],
          summary:
            "Lire la configuration WebAuthn du tenant (owner uniquement)",
          security: [{ bearerAuth: [] }],
        },
      },
      // Tenant effectif de la requête (jamais de DEFAULT_TENANT_ID silencieux).
      async (req) =>
        settingsService.getWebauthn((req as TenantScopedRequest).tenantId!),
    );

    const webauthnBody = z.object({
        enabled: z.boolean(),
        origin: z.string().optional(),
        rpId: z.string().optional(),
        rpName: z.string().optional(),
    })

    app.post(
      "/api/settings/webauthn",
      {
        ...guard("settings.domain.set"),
        schema: {
          body: webauthnBody,
          tags: ["settings"],
          summary:
            "Enregistrer la configuration WebAuthn du tenant (owner uniquement)",
          security: [{ bearerAuth: [] }],
        },
      },
      async (req, reply) => {
        const body = webauthnBody.parse(req.body);
        const tenantId = (req as TenantScopedRequest).tenantId!;
        try {
          const result = await settingsService.setWebauthn(tenantId, body);
          await eventBus.emit("settings.webauthn.set", {
            userId: currentUser(req)?.sub,
            tenantId,
            enabled: body.enabled,
          });
          return result;
        } catch (err) {
          if (err instanceof AuthError) {
            return reply
              .code(err.status)
              .send({ error: err.message, code: err.code });
          }
          // Erreur non métier (ex. base indisponible) : laisser le handler
          // Fastify répondre (500 réel), pas un 400 qui masquerait la cause.
          throw err;
        }
      },
    );
}