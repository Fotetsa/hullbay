import { FastifyInstance } from "fastify";
import { z } from "zod"
import { parse as parseDomain } from "tldts"
import { settingsService } from "./service";
import { currentUser, requireRole } from "../auth/rbac";
import { eventBus } from "../../lib/event-bus";

/**
 * Routes des parametres systeme. Lecture, ecriture reserve au owner
 */
const owner = { preHandler: requireRole("owner") }

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
        "/api/settings/domain", {
            ...owner,
            schema: {
                tags: ["settings"],
                summary: "Lire le nom de domaine configure (uniquement le owner)",
                security: [{ bearerAuth: [] }],
            },
        },
        async () => settingsService.get(),
    )

    const setBody = z.object({
        domain: domainSchema,
    })

    app.post(
        "/api/settings/domain", {
            ...owner,
            schema: {
                body: setBody,
                tags: ["settings"],
                summary: "Définir le nom de domaine (owner uniquement)",
                security: [{ bearerAuth: [] }],
            },
        },
        async (req, reply) => {
            const body = req.body as { domain: string }
            try {
                const result = await settingsService.setDomain(body.domain)
                await eventBus.emit("settings.domain.set", {
                    userId: currentUser(req)?.sub,
                    domain: body.domain,
                })
                return result
            } catch (err) {
                return reply
                .code(400)
                .send({ error: err instanceof Error ? err.message : String(err) })
            }

        },
    )
}