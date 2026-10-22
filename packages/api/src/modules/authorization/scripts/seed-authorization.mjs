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
  if (!tenantId || typeof tenantId !== "string") {
    console.error(`[SEED] ERREUR CRITIQUE: tenantId invalide reçu:`, tenantId);
    throw new Error(
      "tenantId est requis et doit être une chaîne de caractères valide",
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const preset of PRESETS) {
      const existing = await tx.role.findUnique({
        where: {
          tenantId_name: {
            tenantId,
            name: preset.name,
          },
        },
        include: {
          rolePermissions: true,
        },
      });

      if (existing) {
        // Le rôle existe déjà. On ne fait RIEN pour préserver les personnalisations de l'administrateur.
        continue;
      }

      // Le rôle n'existe pas. On le crée AVEC ses permissions par défaut en une seule opération atomique.
      await tx.role.create({
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
                  `[SEED] Permission introuvable dans le catalogue : ${key}`,
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
    }

    // Gestion du rôle Root
    const root = await tx.role.findUnique({
      where: {
        tenantId_name: {
          tenantId,
          name: "Root",
        },
      },
    });

    if (!root) {
      await tx.role.create({
        data: {
          tenantId,
          name: "Root",
          isPreset: false,
          isSystem: true,
        },
      });
    }
  });
}

async function main() {
  console.log("[SEED] Début du peuplement du modèle d'autorisation...");

  const permissionByKey = await ensurePermissions();
  console.log("[SEED] Permissions vérifiées/créées.");

  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  console.log(
    `[SEED] ${tenants.length} tenant(s) trouvé(s) en base de données.`,
  );

  for (const tenant of tenants) {
    console.log(`[SEED] Traitement du tenant ID: ${tenant.id}`);
    await ensurePresetsForTenant(tenant.id, permissionByKey);
  }

  console.log("[SEED] Peuplement terminé avec succès.");
}

main()
  .catch((err) => {
    console.error("Échec du peuplement du modèle d'autorisation :", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
