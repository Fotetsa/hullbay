# Modèle de domaine d'autorisation

Fondation de données du futur système d'autorisation de Hullbay. Cette phase ne contient aucun moteur d'autorisation (`authorization.can()`) et ne migre aucune route.

## 1. Diagramme des entités

```
Tenant
├── Membership (User x Tenant)
│     ├── role     (chaîne historique, conservée)
│     ├── roleId   (nullable, rôle direct)
│     └── TeamMember ── Team
├── Role ── RolePermission ── Permission (globale)
├── Team ── TeamRole ── Role
│     └── ExternalGroupMapping ── AuthProvider (tenant ou global)
└── Policy ── PolicyBinding ── Role | Team
```

Permission est la seule entité du modèle sans tenant : elle décrit une capacité générale du système. Toutes les autres appartiennent à un tenant.

## 2. Catalogue des permissions (50)

Construit à partir des gardes `requireRole` présentes dans 10 fichiers de routes. Cinq fichiers (ldap, saml, sso, sessions, webauthn) n'ont aucune garde : flux d'authentification ou actions d'un utilisateur sur ses propres sessions et facteurs. Le contrôle de `sessions.routes.ts` confirme qu'aucune route n'agit sur la session d'un autre compte, donc aucune permission d'administration n'est ajoutée.

| Permission | Ressource | Action | Scopes |
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

`user.*` désigne l'administration des utilisateurs et memberships du tenant ; User lui-même reste une entité globale. `logs.read` couvre la santé, le drift et le placement : son nom est provisoire.

## 3. Matrice des presets

Viewer (2) : project.read, logs.read.

Operator (19) : Viewer, plus project.create/update/delete/deploy/destroy/rebuild, graph.node.create/update/delete, graph.edge.create/update/delete, secret.read/set/delete, prune.dry, audit.read.

Owner (50) : Operator, plus cluster.read/create/update/delete, server.read/create/delete/promote/demote, registry.read/set/delete, settings.domain.read/set, update.check/apply/rollback/channel, user.read/create/update/delete, provider.read/create/update/delete/test, pending.read/approve/reject, prune.apply.

L'héritage est documentaire : en base, chaque preset reçoit explicitement ses permissions. Aucun mécanisme RoleInheritance n'existe.

## 4. Sémantique des scopes

Un scope est le couple `scopeType` / `scopeId`, jamais NULL. Le scope global d'un tenant vaut `tenant:<tenantId>`. Types actuels : tenant, cluster, server, project, node, edge. La liste est un catalogue de ressources validé par le code (`scope.ts`), pas un enum Prisma, pour qu'ajouter un type ne demande pas de migration structurelle.

Un scope ne crée jamais de hiérarchie implicite : `project.deploy` sur un projet n'accorde pas `cluster.update` sur son cluster. Une couverture descendante n'existera que si la sémantique d'une permission le prévoit, définie par le futur moteur.

Un scope doit désigner une ressource du tenant du rôle ou de l'équipe : c'est vérifié en base par trigger pour les six types connus.

## 5. Resource Catalog (consommé par le futur moteur)

| Permissions | Ressource | Scopes acceptés | Tenant propriétaire | Parent |
|---|---|---|---|---|
| cluster.* | Cluster | selon le catalogue | Cluster.tenantId | Tenant |
| server.* | Server | cluster, server | Server.tenantId | Cluster |
| project.* | Project | selon le catalogue | Project.tenantId | Cluster |
| graph.node.* | Node | project, node | Node, Project, tenantId | Project |
| graph.edge.* | Edge | project, edge | Edge, Project, tenantId | Project |
| secret.* | Docker Secret (hors Prisma) | cluster | Cluster.tenantId | Cluster |
| registry.* | RegistryCredential | tenant | RegistryCredential.tenantId | Tenant |
| settings.domain.* | Settings | tenant | Settings.tenantId | Tenant |
| audit.read | AuditLog | tenant | AuditLog.tenantId (nullable, événements système exclus) | Tenant |
| logs.read | Observability | tenant, cluster, project | via Cluster ou Project | Cluster |
| update.* | SystemUpdate (entité globale) | tenant | contexte de requête | aucun |
| user.* | Membership | tenant | Membership.tenantId | Tenant |
| provider.* | AuthProvider (tenant nullable : global) | tenant | AuthProvider.tenantId | Tenant |
| pending.* | PendingIdentity (entité globale) | tenant | contexte de requête | aucun |
| prune.* | Ressources Docker gérées | tenant, cluster | via Cluster | Cluster |

Écart avec la formulation de V3 : Server et Project portent leur propre `tenantId` dans le schéma réel, il n'est donc pas nécessaire de passer par le cluster. Le tenant vient toujours du contexte de requête et est vérifié contre la ressource, jamais déduit d'un rôle.

## 6. Relations entre ressources

```
Tenant ── Membership, Cluster, Project, RegistryCredential, Settings,
          AuthProvider (nullable), SecurityPolicy, AuditLog (nullable)
Cluster ── Server
Project ── Node, Edge
Project vers Cluster, Server vers Cluster, Node vers Project, Edge vers Project
```

Ces relations ne créent aucune permission implicite. Entités globales : User, AuthIdentity, WebauthnCredential, UserSession, PendingIdentity, SystemInfo, SystemUpdate. Les secrets Docker n'ont pas de table : ils sont autorisés par le scope du cluster qui les héberge.

## 7. Règles d'isolation tenant

Portées par la base, par clés étrangères composites `(tenantId, id)` : Membership vers Role, TeamMember vers Team et Membership, TeamRole vers Team et Role, PolicyBinding vers Policy, Role et Team, ExternalGroupMapping vers Team.

Deux règles ne s'expriment pas par clé étrangère et sont portées par des triggers PostgreSQL :
- ExternalGroupMapping vers AuthProvider : le provider doit être du même tenant ou global (tenant nul). Un provider ne peut pas changer de tenant s'il a des correspondances d'un autre tenant.
- Scopes : `scopeId` doit désigner une ressource du tenant du rôle (RolePermission) ou du tenant de la ligne (TeamRole, PolicyBinding).

Les types de scope inconnus ne sont pas rejetés par la base mais par `isValidScopeType` dans le code.

## 8. Stratégie Root

Un rôle Root par tenant, `isSystem = true`, sans permission, attribué à personne. Des triggers refusent sa suppression (sauf cascade de la suppression du tenant), son renommage, le changement de son marqueur ou de son tenant, toute modification de ses permissions, et son attribution à une adhésion ou une équipe. Sa sémantique opérationnelle sera définie avec l'administration des rôles ; levée du blocage d'attribution par une migration à ce moment-là.

## 9. Compatibilité avec Membership.role

`Membership.role` reste intact. `Membership.roleId` est nullable : renseigné, le futur moteur l'utilise ; vide, il retombe sur la chaîne historique. Aucune adhésion n'est migrée dans cette phase et aucune route ne consomme le nouveau modèle. Le champ historique ne sera retiré qu'une fois toutes les routes migrées.

## 10. Stratégie de migration

Trois migrations : le modèle (additif), le durcissement (clé étrangère `SET NULL ("roleId")`, CHECK sur PolicyBinding et Policy.effect, protection de Root), et la conformité V3 (scopes, provider, attribution de Root). Aucune n'est destructive.

Le seed est idempotent : permissions retrouvées par `key`, rôles par `tenantId + name`. Un preset existant n'est jamais retouché, donc les personnalisations d'un administrateur survivent à un nouveau passage. Les permissions ajoutées plus tard au catalogue ne sont donc pas ajoutées automatiquement aux presets existants.

## 11. Limites de cette phase

Aucun moteur, aucune route migrée, aucune interface. Le contenu des conditions de policy et la synchronisation des groupes IdP restent à définir. Les presets ne sont créés que pour les tenants existants au moment du seed : la création d'un tenant devra les générer dans une phase ultérieure. Le nom `logs.read` est provisoire.