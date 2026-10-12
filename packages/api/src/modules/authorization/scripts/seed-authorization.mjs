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
];

const VIEWER_KEYS = ["project.read", "logs.read"];

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
];

const PRESETS = [
  { name: "Viewer", keys: VIEWER_KEYS },
  { name: "Operator", keys: OPERATOR_KEYS },
  { name: "Owner", keys: OWNER_KEYS },
];

// Un passage de ce script, même répété plusieurs fois, ne doit jamais créer
// de doublon, jamais supprimer une permission existante, jamais toucher aux
// adhésions déjà en place. On retrouve chaque permission par sa clé, chaque
// rôle par son couple tenant et nom, jamais par un nouvel identifiant généré.
async function ensurePermissions() {
  const byKey = new Map();
  for (const [key, resource, action] of PERMISSIONS) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, resource, action },
    });
    byKey.set(key, permission);
  }
  return byKey;
}

async function ensurePresetsForTenant(tenantId, permissionByKey) {
  for (const preset of PRESETS) {
    const role = await prisma.role.upsert({
      where: { tenantId_name: { tenantId, name: preset.name } },
      update: {},
      create: { tenantId, name: preset.name, isPreset: true, isSystem: false },
    });

    for (const key of preset.keys) {
      const permission = permissionByKey.get(key);
      if (!permission) continue;
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId_scopeType_scopeId: {
            roleId: role.id,
            permissionId: permission.id,
            scopeType: "tenant",
            scopeId: tenantId,
          },
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id,
          scopeType: "tenant",
          scopeId: tenantId,
        },
      });
    }
  }


  await prisma.role.upsert({
    where: { tenantId_name: { tenantId, name: "Root" } },
    update: {},
    create: { tenantId, name: "Root", isPreset: false, isSystem: true },
  });
}

async function main() {
  const permissionByKey = await ensurePermissions();
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  for (const tenant of tenants) {
    await ensurePresetsForTenant(tenant.id, permissionByKey);
  }
  console.log(`Peuplement terminé pour ${tenants.length} tenant(s).`);
}

main()
  .catch((err) => {
    console.error("Échec du peuplement du modèle d'autorisation :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
