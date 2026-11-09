import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PERMISSIONS = [
  ["cluster.read", "cluster", "read"],
  ["cluster.create", "cluster", "create"],
  ["cluster.update", "cluster", "update"],
  ["cluster.delete", "cluster", "delete"],
  ["server.read", "server", "read"],
  ["server.create", "server", "create"],
  ["server.delete", "server", "delete"],
  ["server.promote", "server", "promote"],
  ["server.demote", "server", "demote"],
  ["project.read", "project", "read"],
  ["project.create", "project", "create"],
  ["project.update", "project", "update"],
  ["project.delete", "project", "delete"],
  ["project.deploy", "project", "deploy"],
  ["project.destroy", "project", "destroy"],
  ["project.rebuild", "project", "rebuild"],
  ["graph.node.create", "node", "create"],
  ["graph.node.update", "node", "update"],
  ["graph.node.delete", "node", "delete"],
  ["graph.edge.create", "edge", "create"],
  ["graph.edge.update", "edge", "update"],
  ["graph.edge.delete", "edge", "delete"],
  ["secret.read", "secret", "read"],
  ["secret.set", "secret", "set"],
  ["secret.delete", "secret", "delete"],
  ["registry.read", "registry", "read"],
  ["registry.set", "registry", "set"],
  ["registry.delete", "registry", "delete"],
  ["settings.domain.read", "settings", "read"],
  ["settings.domain.set", "settings", "set"],
  ["audit.read", "audit", "read"],
  ["logs.read", "logs", "read"],
  ["update.check", "update", "check"],
  ["update.apply", "update", "apply"],
  ["update.rollback", "update", "rollback"],
  ["update.channel", "update", "channel"],
  ["user.read", "user", "read"],
  ["user.create", "user", "create"],
  ["user.update", "user", "update"],
  ["user.delete", "user", "delete"],
  ["provider.read", "provider", "read"],
  ["provider.create", "provider", "create"],
  ["provider.update", "provider", "update"],
  ["provider.delete", "provider", "delete"],
  ["provider.test", "provider", "test"],
  ["pending.read", "pending", "read"],
  ["pending.approve", "pending", "approve"],
  ["pending.reject", "pending", "reject"],
  ["prune.dry", "prune", "dry"],
  ["prune.apply", "prune", "apply"],
  ["backup.destination.read", "backup", "read"],
  ["backup.destination.set", "backup", "set"],
  ["backup.destination.delete", "backup", "delete"],
  ["backup.policy.read", "backup", "read"],
  ["backup.policy.create", "backup", "create"],
  ["backup.policy.update", "backup", "update"],
  ["backup.policy.delete", "backup", "delete"],
  ["backup.run", "backup", "run"],
  ["backup.artifact.read", "backup", "read"],
  ["backup.artifact.restore", "backup", "restore"],
];

const VIEWER_KEYS = [
  "project.read",
  "logs.read",
  "backup.policy.read",
  "backup.artifact.read",
];

const OPERATOR_KEYS = [
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

const OWNER_KEYS = [
  ...OPERATOR_KEYS,
  "cluster.read",
  "cluster.create",
  "cluster.update",
  "cluster.delete",
  "server.read",
  "server.create",
  "server.delete",
  "server.promote",
  "server.demote",
  "registry.read",
  "registry.set",
  "registry.delete",
  "settings.domain.read",
  "settings.domain.set",
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
  "prune.apply",
  "backup.destination.read",
  "backup.destination.set",
  "backup.destination.delete",
  "backup.artifact.restore",
];

const PRESETS = [
  { name: "Viewer", keys: VIEWER_KEYS },
  { name: "Operator", keys: OPERATOR_KEYS },
  { name: "Owner", keys: OWNER_KEYS },
];

async function ensurePermissions() {
  const byKey = new Map();
  for (const [key, resource, action] of PERMISSIONS) {
    let permission = await prisma.permission.findUnique({ where: { key } });
    if (!permission) {
      permission = await prisma.permission.create({
        data: { key, resource, action },
      });
    }
    byKey.set(key, permission);
  }
  return byKey;
}

async function ensurePresetsForTenant(tenantId, permissionByKey) {
  if (!tenantId || typeof tenantId !== "string") return;

  for (const preset of PRESETS) {
    // Rôle déjà présent : on ajoute uniquement les permissions manquantes.
    // Un preset existant doit hériter des nouvelles permissions du catalogue
    // (ex. domaine backup) sans perdre ses personnalisations de scope.
    const existing = await prisma.role.findUnique({
      where: { tenantId_name: { tenantId, name: preset.name } },
      select: { id: true },
    });
    if (existing) {
      const granted = await prisma.rolePermission.findMany({
        where: { roleId: existing.id },
        select: { permissionId: true },
      });
      const grantedIds = new Set(granted.map((g) => g.permissionId));
      const missing = preset.keys
        .map((key) => permissionByKey.get(key))
        .filter((perm) => perm && !grantedIds.has(perm.id));
      if (missing.length > 0) {
        await prisma.rolePermission.createMany({
          data: missing.map((perm) => ({
            roleId: existing.id,
            permissionId: perm.id,
            scopeType: "tenant",
            scopeId: tenantId,
          })),
          skipDuplicates: true,
        });
      }
      continue;
    }
    try {
      await prisma.role.create({
        data: {
          tenantId,
          name: preset.name,
          isPreset: true,
          isSystem: false,
          rolePermissions: {
            create: preset.keys.map((key) => {
              const perm = permissionByKey.get(key);
              if (!perm) {
                throw new Error(
                  `Permission introuvable dans le catalogue : ${key}`,
                );
              }
              return {
                permissionId: perm.id,
                scopeType: "tenant",
                scopeId: tenantId,
              };
            }),
          },
        },
      });
    } catch (error) {
      if (error.code === "P2002" || error.code === "P2003") {
        continue;
      }
      throw error;
    }
  }

  try {
    await prisma.role.create({
      data: {
        tenantId,
        name: "Root",
        isPreset: false,
        isSystem: true,
      },
    });
  } catch (error) {
    if (error.code === "P2002" || error.code === "P2003") {
      console.warn("Le rôle 'Root' existe déjà ou le tenant a été supprimé.");
    } else {
      throw error;
    }
  }
}

async function main() {
  console.log("Début du peuplement du modèle d'autorisation...");

  const permissionByKey = await ensurePermissions();
  console.log("Permissions vérifiées ou créées.");

  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  console.log(`${tenants.length} tenant(s) trouvé(s) en base de données.`);

  for (const tenant of tenants) {
    await ensurePresetsForTenant(tenant.id, permissionByKey);
  }

  console.log("Peuplement terminé avec succès.");
}

main()
  .catch((err) => {
    console.error("Échec du peuplement du modèle d'autorisation :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
