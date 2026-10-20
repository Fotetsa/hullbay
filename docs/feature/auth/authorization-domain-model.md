# AUTHORIZATION DOMAIN MODEL, V3 (Phase 1)

Documentation technique de la fondation de données du système d'autorisation de Hullbay. Cette phase ne contient aucun moteur d'autorisation (`authorization.can()`, `check()`, `require()`) et ne migre aucune route. Livrables : modèle Prisma, migrations, seed idempotent, contraintes d'intégrité, tests d'intégrité, compatibilité avec le modèle historique.

## 1. Diagramme des entités

```
Tenant
├── Membership (User x Tenant)
│     ├── role      chaîne historique, conservée
│     ├── roleId    nullable, rôle direct
│     └── TeamMember ── Team
├── Role ── RolePermission ── Permission (globale, sans tenant)
├── Team ── TeamRole ── Role
│     └── ExternalGroupMapping ── AuthProvider (du tenant ou global)
└── Policy ── PolicyBinding ── Role | Team
```

Permission est la seule entité du modèle sans tenant : elle décrit une capacité générale du système. Toutes les autres appartiennent à exactement un tenant.

## 2. Catalogue des permissions (50)

Le catalogue vient des gardes `requireRole` présentes dans 10 fichiers de routes (auth.routes, pending, providers, users, clusters, observability, projects, reconciler, registry, secrets, servers, settings, updates). Aucune permission n'a été ajoutée sans correspondance avec le code. Les permissions sont des lignes de la table `Permission` : aucune énumération TypeScript n'existe, et en ajouter une ne demande aucune modification du schéma.

| Permission | Ressource | Action | Scopes acceptés |
|---|---|---|---|
| cluster.read | Cluster | read | tenant, cluster |
| cluster.create | Cluster | create | tenant |
| cluster.update | Cluster | update | cluster |
| cluster.delete | Cluster | delete | cluster |
| server.read | Server | read | cluster, server |
| server.create | Server | create | cluster |
| server.delete | Server | delete | server |
| server.promote | Server | promote | server |
| server.demote | Server | demote | server |
| project.read | Project | read | tenant, cluster, project |
| project.create | Project | create | tenant, cluster |
| project.update | Project | update | project |
| project.delete | Project | delete | project |
| project.deploy | Project | deploy | project |
| project.destroy | Project | destroy | project |
| project.rebuild | Project | rebuild | project |
| graph.node.create | Node | create | project |
| graph.node.update | Node | update | node |
| graph.node.delete | Node | delete | node |
| graph.edge.create | Edge | create | project |
| graph.edge.update | Edge | update | edge |
| graph.edge.delete | Edge | delete | edge |
| secret.read | Docker Secret | read | cluster |
| secret.set | Docker Secret | set | cluster |
| secret.delete | Docker Secret | delete | cluster |
| registry.read | RegistryCredential | read | tenant |
| registry.set | RegistryCredential | set | tenant |
| registry.delete | RegistryCredential | delete | tenant |
| settings.domain.read | Settings | read | tenant |
| settings.domain.set | Settings | set | tenant |
| audit.read | AuditLog | read | tenant |
| logs.read | Observability | read | tenant, cluster, project |
| update.check | SystemUpdate | check | tenant |
| update.apply | SystemUpdate | apply | tenant |
| update.rollback | SystemUpdate | rollback | tenant |
| update.channel | SystemUpdate | channel | tenant |
| user.read | User/Membership | read | tenant |
| user.create | User/Membership | create | tenant |
| user.update | User/Membership | update | tenant |
| user.delete | User/Membership | delete | tenant |
| provider.read | AuthProvider | read | tenant |
| provider.create | AuthProvider | create | tenant |
| provider.update | AuthProvider | update | tenant |
| provider.delete | AuthProvider | delete | tenant |
| provider.test | AuthProvider | test | tenant |
| pending.read | PendingIdentity | read | tenant |
| pending.approve | PendingIdentity | approve | tenant |
| pending.reject | PendingIdentity | reject | tenant |
| prune.dry | Orphan Resources | dry | tenant, cluster |
| prune.apply | Orphan Resources | apply | tenant, cluster |

`user.*` désigne l'administration des utilisateurs et memberships du tenant ; `User` lui-même reste une entité globale. Des clés plus précises (par exemple `membership.role.assign`) ne sont pas créées ici faute de besoin réel dans le code.

`logs.read` couvre aujourd'hui la santé, le drift et le placement. Ce nom est provisoire et sera affiné avant le branchement du moteur si ces notions doivent être autorisées séparément.

### 2.1 Routes sans permission RBAC

`ldap.routes.ts`, `saml.routes.ts`, `sso.routes.ts`, `sessions.routes.ts` et `webauthn.routes.ts` n'ont aucune garde de rôle : ce sont des flux d'authentification ou des actions d'un utilisateur sur ses propres sessions et facteurs. La lecture de `sessions.routes.ts` confirme que chaque route vérifie que la session appartient à l'appelant (404 sinon) et que la révocation de masse ne vise que l'appelant. Aucune route n'agit sur la session d'un autre compte : aucune permission d'administration n'est ajoutée.

## 3. Matrice des presets

Viewer (2) : `project.read`, `logs.read`.

Operator (19) : Viewer, plus `project.create`, `project.update`, `project.delete`, `project.deploy`, `project.destroy`, `project.rebuild`, `graph.node.create`, `graph.node.update`, `graph.node.delete`, `graph.edge.create`, `graph.edge.update`, `graph.edge.delete`, `secret.read`, `secret.set`, `secret.delete`, `prune.dry`, `audit.read`.

Owner (50) : Operator, plus `cluster.read`, `cluster.create`, `cluster.update`, `cluster.delete`, `server.read`, `server.create`, `server.delete`, `server.promote`, `server.demote`, `registry.read`, `registry.set`, `registry.delete`, `settings.domain.read`, `settings.domain.set`, `update.check`, `update.apply`, `update.rollback`, `update.channel`, `user.read`, `user.create`, `user.update`, `user.delete`, `provider.read`, `provider.create`, `provider.update`, `provider.delete`, `provider.test`, `pending.read`, `pending.approve`, `pending.reject`, `prune.apply`.

Les presets sont des `Role` ordinaires (`isPreset = true`, `isSystem = false`). L'héritage ci-dessus est purement documentaire : la base reçoit les permissions de chaque preset de façon explicite, et aucun mécanisme RoleInheritance n'existe.

## 4. Scopes

Un scope est le couple `scopeType` / `scopeId`, jamais NULL. Le scope global d'un tenant s'écrit `scopeType = "tenant"`, `scopeId = <tenantId>` (exemple : `project.read` avec `tenant:A` signifie lire les projets du tenant A). Un scope précis s'écrit par exemple `project:123`.

Types autorisés : `tenant`, `cluster`, `server`, `project`, `node`, `edge`. Ce n'est volontairement pas un enum Prisma : ajouter une ressource autorisable ne doit pas exiger de migration. Le refus d'un type inconnu est porté par `isValidScopeType` (`scope.ts`).

Un scope ne crée aucune hiérarchie implicite : `project.deploy` sur `project:123` n'accorde pas `cluster.update` sur le cluster qui l'héberge. Une permission donnée à un scope supérieur ne couvre les ressources descendantes que si la sémantique de la permission le prévoit, ce que définira le futur moteur à partir du Resource Catalog.

## 5. Resource Catalog (consommé par le futur moteur)

Il n'est pas implémenté comme moteur dans cette phase. Chaque permission a un mapping vers un type de ressource, des scopes acceptés (voir la colonne « Scopes acceptés » de la section 2), un chemin vers le tenant propriétaire et un parent éventuel.

| Permissions | Ressource | Tenant propriétaire | Parent |
|---|---|---|---|
| cluster.* | Cluster | Cluster.tenantId | Tenant |
| server.* | Server | Server.tenantId (équivalent à Server.cluster.tenantId) | Cluster |
| project.* | Project | Project.tenantId | Cluster |
| graph.node.* | Node | Node.project.tenantId | Project |
| graph.edge.* | Edge | Edge.project.tenantId | Project |
| secret.* | Docker Secret (hors Prisma) | Cluster.tenantId | Cluster |
| registry.* | RegistryCredential | RegistryCredential.tenantId | Tenant |
| settings.domain.* | Settings | Settings.tenantId | Tenant |
| audit.read | AuditLog | AuditLog.tenantId (nullable : les événements système sont hors périmètre) | Tenant |
| logs.read | Observability | via Cluster ou Project | Cluster |
| update.* | SystemUpdate (entité globale) | contexte de requête | aucun |
| user.* | Membership | Membership.tenantId | Tenant |
| provider.* | AuthProvider (tenant nullable : global) | AuthProvider.tenantId | Tenant |
| pending.* | PendingIdentity (entité globale) | contexte de requête | aucun |
| prune.* | Ressources Docker gérées | via Cluster | Cluster |

Le tenant vient toujours du contexte de requête et est vérifié contre la ressource ciblée. Il n'est jamais déduit d'un rôle.

## 6. Relations entre ressources

```
Tenant
├── Membership
├── Cluster
│     └── Server
├── Project
│     ├── Node
│     └── Edge
├── RegistryCredential
├── Settings
├── AuthProvider (tenantId nullable : provider global)
├── SecurityPolicy
└── AuditLog (tenantId nullable : événement système)

Project -> Cluster      un projet appartient à exactement un cluster
Server  -> Cluster      un serveur appartient à exactement un cluster
Node    -> Project
Edge    -> Project      relie deux Node du même projet
```

Ces relations ne créent aucune permission implicite. Entités globales : `User`, `AuthIdentity`, `WebauthnCredential`, `UserSession`, `PendingIdentity`, `SystemInfo`, `SystemUpdate` ; certaines de leurs opérations restent tenant-scoped via `Membership`, le provider ou le contexte de l'identité en attente. Les secrets Docker n'ont pas de table : ils sont autorisés par le scope du cluster qui les héberge, et aucune table `Secret` n'est introduite pour le RBAC.

Écart avec la V3 (§16 et §28) : `Server` et `Project` portent leur propre `tenantId` dans le schéma réel, il n'est donc pas nécessaire de passer par le cluster pour retrouver le tenant.

## 7. Isolation tenant

Portée par la base, via des clés étrangères composites `(tenantId, id)` : Membership vers Role, TeamMember vers Team et vers Membership, TeamRole vers Team et vers Role, PolicyBinding vers Policy, Role et Team, ExternalGroupMapping vers Team. Chaque modèle cible porte `@@unique([tenantId, id])` pour permettre ces clés.

Trois règles ne s'expriment pas par une clé étrangère et sont portées par des triggers PostgreSQL :
- ExternalGroupMapping vers AuthProvider : le provider doit appartenir au même tenant ou être global (tenant nul). Une clé composite exigerait l'égalité des tenants, ce qui est impossible pour un provider global. Un provider ne peut pas changer de tenant s'il a des correspondances d'un autre tenant.
- Scopes : `scopeId` doit désigner une ressource du tenant du rôle (RolePermission) ou du tenant de la ligne (TeamRole, PolicyBinding), pour les six types connus.
- Rôles système : voir section 9.

Les contrôles applicatifs ne sont donc pas la seule protection contre une association entre deux tenants.

## 8. Policies

`Policy` et `PolicyBinding` sont créées mais non évaluées. `effect` n'accepte que `allow` ou `deny` (contrainte CHECK en base, validation applicative à prévoir). Un `PolicyBinding` doit viser au moins un rôle ou une équipe (CHECK), et `scopeType` / `scopeId` doivent être tous deux présents ou tous deux absents. La syntaxe de `conditions` n'est volontairement pas définie dans cette phase.

## 9. Stratégie Root

Un rôle Root par tenant (jamais partagé entre tenants), `isSystem = true`, `isPreset = false`, sans permission, attribué à personne. Des triggers PostgreSQL refusent : sa suppression (sauf la cascade de suppression du tenant), son renommage, le changement de son marqueur ou de son tenant, tout ajout, modification ou retrait de ses permissions, et son attribution à une adhésion ou une équipe. Aucune sémantique spéciale de Root n'existe dans cette phase. Sa sémantique opérationnelle sera définie avec l'administration des rôles ; le blocage d'attribution sera alors levé par une migration.

## 10. Compatibilité avec Membership.role

`Membership.role` reste intact. `Membership.roleId` est nullable : renseigné, le futur moteur l'utilisera ; vide, il retombera sur la chaîne historique. Aucune adhésion n'est migrée, aucune route n'est modifiée, aucune ancienne garde n'est supprimée. Le champ historique et `User.role` ne seront retirés qu'une fois toutes les routes migrées. Trajectoire : Phase 3 (branchement des routes), Phase 7 (migration puis retrait du legacy).

## 11. Migration et seed

Trois migrations, aucune destructive :
1. Modèle : tables, index, clés étrangères composites, colonne `Membership.roleId`.
2. Durcissement : clé étrangère de `Membership.roleId` avec `ON DELETE SET NULL ("roleId")` (seul `roleId` est mis à NULL, `tenantId` est obligatoire), CHECK sur `PolicyBinding` et `Policy.effect`, triggers de protection des rôles système.
3. Conformité V3 : cohérence tenant des scopes, ExternalGroupMapping vers AuthProvider, interdiction d'attribuer un rôle système, CHECK sur le couple scopeType / scopeId.

Si une donnée existante violait une contrainte, la migration échouerait explicitement : aucune donnée n'est corrigée en silence.

Seed (`npm run seed:authorization`), idempotent : permissions retrouvées par `key`, rôles par `tenantId + name`. Dans l'ordre : permissions, presets Owner/Operator/Viewer par tenant avec leurs permissions explicites, Root sans attribution, aucune Membership modifiée. Un preset déjà présent n'est jamais retouché, donc les personnalisations d'un administrateur survivent à une nouvelle exécution (conséquence : une permission ajoutée plus tard au catalogue n'est pas ajoutée automatiquement aux presets existants).

## 12. Schéma Prisma

```prisma
model Role {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  description String?
  isSystem    Boolean  @default(false)
  isPreset    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant          Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  rolePermissions RolePermission[]
  teamRoles       TeamRole[]
  memberships     Membership[]
  policyBindings  PolicyBinding[]

  @@unique([tenantId, name])
  @@unique([tenantId, id])
  @@index([tenantId])
}

model Permission {
  id          String   @id @default(cuid())
  key         String   @unique
  resource    String
  action      String
  description String?
  createdAt   DateTime @default(now())

  rolePermissions RolePermission[]

  @@index([resource, action])
}

model RolePermission {
  id           String @id @default(cuid())
  roleId       String
  permissionId String
  scopeType    String
  scopeId      String

  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([roleId, permissionId, scopeType, scopeId])
  @@index([roleId])
  @@index([permissionId])
  @@index([scopeType, scopeId])
}

model Team {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant                Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  members               TeamMember[]
  roles                 TeamRole[]
  externalGroupMappings ExternalGroupMapping[]
  policyBindings        PolicyBinding[]

  @@unique([tenantId, name])
  @@unique([tenantId, id])
  @@index([tenantId])
}

model TeamMember {
  id           String   @id @default(cuid())
  tenantId     String
  teamId       String
  membershipId String
  joinedAt     DateTime @default(now())

  team       Team       @relation(fields: [tenantId, teamId], references: [tenantId, id], onDelete: Cascade)
  membership Membership @relation(fields: [tenantId, membershipId], references: [tenantId, id], onDelete: Cascade)

  @@unique([teamId, membershipId])
  @@unique([tenantId, id])
  @@index([tenantId])
  @@index([membershipId])
}

model TeamRole {
  id        String @id @default(cuid())
  tenantId  String
  teamId    String
  roleId    String
  scopeType String
  scopeId   String

  team Team @relation(fields: [tenantId, teamId], references: [tenantId, id], onDelete: Cascade)
  role Role @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)

  @@unique([teamId, roleId, scopeType, scopeId])
  @@unique([tenantId, id])
  @@index([tenantId])
  @@index([teamId])
  @@index([roleId])
  @@index([scopeType, scopeId])
}

model Policy {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  description String?
  effect      String
  conditions  Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant   Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  bindings PolicyBinding[]

  @@unique([tenantId, name])
  @@unique([tenantId, id])
  @@index([tenantId])
}

model PolicyBinding {
  id        String  @id @default(cuid())
  tenantId  String
  policyId  String
  roleId    String?
  teamId    String?
  scopeType String?
  scopeId   String?

  policy Policy @relation(fields: [tenantId, policyId], references: [tenantId, id], onDelete: Cascade)
  role   Role?  @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)
  team   Team?  @relation(fields: [tenantId, teamId], references: [tenantId, id], onDelete: Cascade)

  @@unique([tenantId, id])
  @@index([tenantId])
  @@index([policyId])
  @@index([roleId])
  @@index([teamId])
  @@index([scopeType, scopeId])
}

model ExternalGroupMapping {
  id                String   @id @default(cuid())
  tenantId          String
  providerId        String
  externalGroupName String
  teamId            String
  createdAt         DateTime @default(now())

  tenant   Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  provider AuthProvider @relation(fields: [providerId], references: [id], onDelete: Cascade)
  team     Team         @relation(fields: [tenantId, teamId], references: [tenantId, id], onDelete: Cascade)

  @@unique([tenantId, providerId, externalGroupName])
  @@unique([tenantId, id])
  @@index([tenantId])
  @@index([providerId])
  @@index([teamId])
}

model Membership {
  id        String   @id @default(cuid())
  userId    String
  tenantId  String
  role      String   // legacy, conservé
  roleId    String?  // nouveau rôle direct
  createdAt DateTime @default(now())

  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  roleRef     Role?        @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: SetNull)
  teamMembers TeamMember[]

  @@unique([userId, tenantId])
  @@unique([tenantId, id])
}
```

Relations inverses ajoutées : `Tenant` (roles, teams, policies, externalGroupMappings) et `AuthProvider` (externalGroupMappings). Le comportement `ON DELETE SET NULL ("roleId")` de `Membership` est posé en SQL (migration 2), Prisma ne sait pas l'exprimer.

## 13. Tests

`packages/api/src/modules/authorization/__tests__/domain-model.integration.test.ts`, contre une vraie base :
- Isolation : les six associations entre tenants exigées sont rejetées (Membership vers Role, TeamMember vers Membership, TeamRole vers Role, PolicyBinding vers Role et vers Team, ExternalGroupMapping vers Team), plus ExternalGroupMapping vers un provider d'un autre tenant ; provider global et association correcte acceptés.
- Unicité : rôle, équipe, policy, clé de permission, RolePermission et TeamRole par scope, ExternalGroupMapping ; même scope permis sur plusieurs rôles.
- Scopes : six types valides, type inconnu refusé, scope global `tenant:<id>`, `scopeId` d'un autre tenant refusé (RolePermission et TeamRole).
- Root : suppression, renommage, perte du marqueur, ajout de permission, attribution refusés ; un seul Root par tenant.
- Presets : Viewer 2, Operator 19, Owner 50, contenu exact, `isPreset` / `isSystem`.
- Migration et seed : seconde exécution sans doublon, personnalisations d'un preset conservées, `Membership.role`, tenants et adhésions préservés.

## 14. Correspondance avec la Definition of Done

| Critère V3 | Preuve |
|---|---|
| Schéma complet, sans placeholder | Section 12 |
| Migrations créées | Section 11, dossier `prisma/migrations` |
| Seed idempotent, presets par tenant, Root protégé | Tests « presets » et « migration, peuplement » |
| `Membership.role` préservé, `roleId` nullable | Test de préservation, schéma |
| Isolation Team, Role, Policy, TeamMember, TeamRole, PolicyBinding, ExternalGroupMapping | Tests « isolation entre tenants » |
| Relation réelle vers AuthProvider | Schéma + trigger + test |
| Scope global `tenant:<id>`, scope d'un autre tenant refusé | Tests « scopes » |
| Aucun `authorization.can()`, aucune route migrée | Périmètre de la PR |
| Migration testée sur base vide et sur base existante | À cocher après exécution (voir la PR) |

## 15. Limites de cette phase

Aucun moteur, aucune route migrée, aucune interface. Le contenu des conditions de policy et la synchronisation des groupes IdP restent à définir. Les presets ne sont créés que pour les tenants existants au moment du seed ; la création d'un tenant devra les générer dans une phase ultérieure. Le nom `logs.read` est provisoire. Les types de scope inconnus sont refusés par le code, pas par la base.