// Données et logique de peuplement partagées par le seed, sync-catalog,
// la réparation au démarrage et createTenantPresets. Aucune dépendance applicative.

export const PREVIOUS_KEYS = [
  "cluster.read",
  "cluster.create",
  "cluster.update",
  "cluster.delete",
  "server.read",
  "server.create",
  "server.delete",
  "server.promote",
  "server.demote",
  "project.read",
  "project.create",
  "project.update",
  "project.delete",
  "project.deploy",
  "project.destroy",
  "project.rebuild",
  "graph.node.create",
  "graph.node.update",
  "graph.node.delete",
  "graph.edge.create",
  "graph.edge.update",
  "graph.edge.delete",
  "secret.read",
  "secret.set",
  "secret.delete",
  "registry.read",
  "registry.set",
  "registry.delete",
  "backup.destination.read",
  "backup.destination.set",
  "backup.destination.delete",
  "backup.policy.read",
  "backup.policy.create",
  "backup.policy.update",
  "backup.policy.delete",
  "backup.run",
  "backup.artifact.read",
  "backup.artifact.restore",
  "settings.domain.read",
  "settings.domain.set",
  "audit.read",
  "logs.read",
  "update.check",
  "update.apply",
  "update.rollback",
  "update.channel",
  "user.read",
  "user.create",
  "user.update",
  "user.delete",
  "provider.read",
  "provider.create",
  "provider.update",
  "provider.delete",
  "provider.test",
  "pending.read",
  "pending.approve",
  "pending.reject",
  "prune.dry",
  "prune.apply",
];

export const ADMIN_KEYS = [
  "role.read",
  "role.create",
  "role.update",
  "role.delete",
  "team.read",
  "team.create",
  "team.update",
  "team.delete",
  "team.member.assign",
  "team.role.assign",
  "membership.role.assign",
  "authorization.read",
];

export const ALL_KEYS = [...PREVIOUS_KEYS, ...ADMIN_KEYS];

export const VIEWER_KEYS = [
  "project.read",
  "logs.read",
  "backup.policy.read",
  "backup.artifact.read",
];

export const OPERATOR_KEYS = [
  ...VIEWER_KEYS,
  "project.create",
  "project.update",
  "project.delete",
  "project.deploy",
  "project.destroy",
  "project.rebuild",
  "graph.node.create",
  "graph.node.update",
  "graph.node.delete",
  "graph.edge.create",
  "graph.edge.update",
  "graph.edge.delete",
  "secret.read",
  "secret.set",
  "secret.delete",
  "prune.dry",
  "audit.read",
  "backup.policy.create",
  "backup.policy.update",
  "backup.policy.delete",
  "backup.run",
];

export const OWNER_KEYS = ALL_KEYS;

export const PRESETS = [
  { name: "Viewer", keys: VIEWER_KEYS },
  { name: "Operator", keys: OPERATOR_KEYS },
  { name: "Owner", keys: OWNER_KEYS },
];
export const ROOT_NAME = "Root";

export async function ensurePermissions(db) {
  const byKey = new Map();
  for (const key of ALL_KEYS) {
    const i = key.indexOf(".");
    const p = await db.permission.upsert({
      where: { key },
      update: {},
      create: { key, resource: key.slice(0, i), action: key.slice(i + 1) },
    });
    byKey.set(key, p);
  }
  return byKey;
}

// Idempotent : un rôle existant n'est jamais retouché les personnalisations survivent.
export async function ensureTenantPresets(db, tenantId, byKey) {
  if (!tenantId || typeof tenantId !== "string")
    throw new Error("tenantId invalide");
  await db.$transaction(async (tx) => {
    for (const preset of PRESETS) {
      const existing = await tx.role.findUnique({
        where: { tenantId_name: { tenantId, name: preset.name } },
      });
      if (existing) continue;
      await tx.role.create({
        data: {
          tenantId,
          name: preset.name,
          isPreset: true,
          isSystem: false,
          rolePermissions: {
            create: preset.keys.map((key) => {
              const perm = byKey.get(key);
              if (!perm) throw new Error(`permission introuvable : ${key}`);
              return {
                permissionId: perm.id,
                scopeType: "tenant",
                scopeId: tenantId,
              };
            }),
          },
        },
      });
    }
    const root = await tx.role.findUnique({
      where: { tenantId_name: { tenantId, name: ROOT_NAME } },
    });
    if (!root) {
      await tx.role.create({
        data: { tenantId, name: ROOT_NAME, isPreset: false, isSystem: true },
      });
    }
  });
}

// Ajoute les permissions d'administration au preset Owner NON personnalisé.
// Un Owner modifié est laissé tel quel et signalé. Ne retire jamais rien.
export async function syncCatalog(db) {
  const byKey = await ensurePermissions(db);
  const report = { updated: [], skipped: [] };
  const tenants = await db.tenant.findMany({ select: { id: true } });
  for (const t of tenants) {
    const owner = await db.role.findUnique({
      where: { tenantId_name: { tenantId: t.id, name: "Owner" } },
      include: { rolePermissions: { include: { permission: true } } },
    });
    if (!owner) {
      report.skipped.push({ tenantId: t.id, reason: "aucun preset Owner" });
      continue;
    }
    const atTenant = owner.rolePermissions.filter(
      (rp) => rp.scopeType === "tenant" && rp.scopeId === t.id,
    );
    const keys = atTenant.map((rp) => rp.permission.key);
    const missing = ADMIN_KEYS.filter((k) => !keys.includes(k));
    if (missing.length === 0) continue;
    const unmodified =
      atTenant.length === owner.rolePermissions.length &&
      PREVIOUS_KEYS.every((k) => keys.includes(k)) &&
      keys.every((k) => ALL_KEYS.includes(k));
    if (!unmodified) {
      report.skipped.push({
        tenantId: t.id,
        reason:
          "preset Owner personnalisé : permissions d'administration à attribuer manuellement",
      });
      continue;
    }
    await db.rolePermission.createMany({
      data: missing.map((k) => ({
        roleId: owner.id,
        permissionId: byKey.get(k).id,
        scopeType: "tenant",
        scopeId: t.id,
      })),
      skipDuplicates: true,
    });
    report.updated.push(t.id);
  }
  return report;
}
