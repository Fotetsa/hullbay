import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { RESOURCE_CATALOG } from "../catalog/resource-catalog";
import { isValidScopeType, type ScopeType } from "../scope";
import { PrismaResourceRepository } from "../repositories/prisma";
import { AdminError } from "./errors";

export const MAX_GRANTS_PER_ROLE = 200;
export const MAX_ASSIGNMENTS_PER_TEAM = 100;

export const nameSchema = z.string().trim().min(1).max(64);
export const descriptionSchema = z.string().trim().max(500);
export const grantInputSchema = z
  .object({
    permission: z.string().min(1).max(100),
    scopeType: z.string().min(1).max(32).optional(),
    scopeId: z.string().min(1).max(64).optional(),
  })
  .strict();

export type GrantInput = z.infer<typeof grantInputSchema>;
export type Grant = { key: string; scopeType: string; scopeId: string };
export const sig = (g: Grant) => `${g.key}|${g.scopeType}|${g.scopeId}`;

const invalidScope = () =>
  new AdminError(400, "invalid_scope", "scope invalide");

/** Un scope désigne le tenant lui-même ou une ressource de CE tenant (réponse uniforme sinon). */
export async function validateScope(
  tx: Prisma.TransactionClient,
  tenantId: string,
  scopeType?: string,
  scopeId?: string,
): Promise<{ scopeType: ScopeType; scopeId: string }> {
  const type = scopeType ?? "tenant";
  if (!isValidScopeType(type)) throw invalidScope();
  if (type === "tenant") {
    if (scopeId !== undefined && scopeId !== tenantId) throw invalidScope();
    return { scopeType: "tenant", scopeId: tenantId };
  }
  if (!scopeId) throw invalidScope();
  const rec = await new PrismaResourceRepository(
    tx as unknown as PrismaClient,
  ).load(type, scopeId);
  if (!rec || rec.tenantId !== tenantId) throw invalidScope();
  return { scopeType: type, scopeId };
}

export async function validateGrants(
  tx: Prisma.TransactionClient,
  tenantId: string,
  inputs: GrantInput[],
): Promise<Grant[]> {
  if (inputs.length > MAX_GRANTS_PER_ROLE) {
    throw new AdminError(
      400,
      "too_many_grants",
      `maximum ${MAX_GRANTS_PER_ROLE} droits par rôle`,
    );
  }
  const out = new Map<string, Grant>();
  for (const i of inputs) {
    const entry = RESOURCE_CATALOG.get(i.permission);
    if (!entry)
      throw new AdminError(400, "unknown_permission", "permission inconnue");
    const scope = await validateScope(tx, tenantId, i.scopeType, i.scopeId);
    const accepted = new Set<string>([...entry.scopes, "tenant"]);
    if (!accepted.has(scope.scopeType)) {
      throw new AdminError(
        400,
        "scope_not_accepted",
        "ce type de scope n'est pas accepté par la permission",
      );
    }
    const g = { key: i.permission, ...scope };
    out.set(sig(g), g);
  }
  return [...out.values()];
}

export async function permissionIds(
  tx: Prisma.TransactionClient,
  grants: Grant[],
): Promise<Map<string, string>> {
  const keys = [...new Set(grants.map((g) => g.key))];
  const rows = await tx.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true, key: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.id]));
  if (keys.some((k) => !map.has(k))) {
    throw new AdminError(
      409,
      "permission_not_seeded",
      "catalogue non synchronisé : lancer seed:authorization",
    );
  }
  return map;
}
