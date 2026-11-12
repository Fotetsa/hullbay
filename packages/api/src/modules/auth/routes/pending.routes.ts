/**
 * Routes d'administration des identités externes en attente d'approbation
 * (owner uniquement).
 *
 * GET  /api/auth/admin/pendings              → liste des demandes
 * POST /api/auth/admin/pendings/:id/approve  → {tenantId, role} → User+AuthIdentity+Membership
 * POST /api/auth/admin/pendings/:id/reject   → marque rejected
 *
 * Anti-énumération : id inconnu OU demande déjà traitée → 404 uniforme.
 * Le role du User mirror V1 et la Membership reçoivent le rôle demandé.
 */

import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { currentUser, type Role as LegacyRole } from "../authorization/rbac";
import { requirePermission } from "../../authorization/http";
import { prisma } from "../../../lib/prisma"
import type { TenantScopedRequest } from "../tenancy/tenant-resolver"
import { DEFAULT_TENANT_ID } from "../identity/auth-identity.service"
import {
  listPendingIdentities,
  getPendingIdentity,
  approvePendingIdentity,
  rejectPendingIdentity,
  PendingApprovalError,
} from "../identity/pending-approval.service"

const guard = (action: string, legacyMin: LegacyRole = "owner") => ({
  preHandler: requirePermission(action, { legacyMin }),
});

export async function registerPendingRoutes(app: FastifyInstance) {
  // Tenants disponibles pour l'approbation (owner). Le tenant de rattachement
  // (Membership) est un choix de l'owner au moment d'approuver — on liste ici
  // les cibles possibles pour alimenter l'UI, jamais les membres.
  app.get(
    "/api/auth/admin/tenants",
    {
      ...guard("pending.approve"),
      schema: {
        tags: ["auth"],
        summary: "Liste des tenants (owner) pour l'approbation d'identités",
        security: [{ bearerAuth: [] }],
      },
    },
    async () =>
      prisma.tenant.findMany({
        select: { id: true, name: true, slug: true },
        orderBy: { createdAt: "asc" },
      }),
  );

  app.get(
    "/api/auth/admin/pendings",
    {
      ...guard("pending.read"),
      schema: {
        tags: ["auth"],
        summary:
          "Liste des identités externes en attente d'approbation (owner)",
        security: [{ bearerAuth: [] }],
      },
    },
    async () => listPendingIdentities(),
  );

  const approveBody = z.object({
    tenantId: z.string().min(1, "tenant requis"),
    role: z.enum(["owner", "operator", "viewer"]),
  })

  app.post(
    "/api/auth/admin/pendings/:id/approve",
    {
      ...guard("pending.approve"),
      schema: {
        body: approveBody,
        tags: ["auth"],
        summary:
          "Approuve une identité : crée User + AuthIdentity + Membership (owner)",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = approveBody.parse(req.body);
      // l'approbation est bornée au tenant effectif de l'acteur
      // (posé par la garde). Un owner tenant-A ne peut PLUS octroyer owner/vues
      // sur un AUTRE tenant (escalade cross-tenant). Requête cross-tenant → 403
      // AVANT toute lecture pending (pas d'oracle d'existence).
      const actorTenant =
        (req as TenantScopedRequest).tenantId ?? DEFAULT_TENANT_ID;
      if (body.tenantId !== actorTenant) {
        return reply
          .code(403)
          .send({
            error: "approbation limitée au tenant courant",
            code: "tenant_forbidden",
          });
      }
      const pending = await getPendingIdentity(id);
      if (!pending)
        return reply
          .code(404)
          .send({ error: "demande introuvable ou déjà traitée" });
      try {
        const result = await approvePendingIdentity(
          pending,
          currentUser(req)?.sub,
          {
            tenantId: body.tenantId,
            role: body.role,
          },
        );
        return {
          ok: true,
          user: result,
          message: "identité approuvée — compte provisionné",
        };
      } catch (err) {
        if (err instanceof PendingApprovalError) {
          // Conflit : compte existant sur un email que le provider ne vérifie
          // pas → 409 (pas un 400 générique) pour signaler le refus de lien.
          if (err.code === "email_not_verified") {
            return reply.code(409).send({ error: err.message, code: err.code });
          }
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  const rejectBody = z.object({
    reason: z.string().max(500).optional(),
  })

  app.post(
    "/api/auth/admin/pendings/:id/reject",
    {
      ...guard("pending.reject"),
      schema: {
        body: rejectBody,
        tags: ["auth"],
        summary: "Rejette une identité en attente (owner) — trace conservée",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = rejectBody.parse(req.body);
      const pending = await getPendingIdentity(id);
      if (!pending)
        return reply
          .code(404)
          .send({ error: "demande introuvable ou déjà traitée" });
      await rejectPendingIdentity(pending, currentUser(req)?.sub, body.reason);
      return { ok: true, message: "demande rejetée" };
    },
  );
}