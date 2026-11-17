import type { PrismaClient, Permission } from "@prisma/client";

export const PREVIOUS_KEYS: readonly string[];
export const ADMIN_KEYS: readonly string[];
export const ALL_KEYS: readonly string[];
export const VIEWER_KEYS: readonly string[];
export const OPERATOR_KEYS: readonly string[];
export const OWNER_KEYS: readonly string[];
export const ROOT_NAME: string;
export function ensurePermissions(
  db: PrismaClient,
): Promise<Map<string, Permission>>;
export function ensureTenantPresets(
  db: PrismaClient,
  tenantId: string,
  byKey: Map<string, Permission>,
): Promise<void>;
export function syncCatalog(
  db: PrismaClient,
): Promise<{
  updated: string[];
  skipped: { tenantId: string; reason: string }[];
}>;
