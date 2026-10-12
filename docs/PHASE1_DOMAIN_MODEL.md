# AUTHORIZATION DOMAIN MODEL — V2

> **Document de conception avant implémentation.**
> 
> Cette phase définit le modèle de données qui supportera le futur moteur d'autorisation Hullbay.
> Aucune implémentation du moteur d'autorisation (`authorization.can()`) ne doit commencer tant que ce modèle n'est pas validé.

---

## 1. Contexte

Le modèle actuel de Hullbay repose encore sur des rôles historiques (`owner`, `operator`, `viewer`) stockés sous forme de chaîne dans `Membership.role`. Le schéma actuel confirme que `Membership` relie `User` et `Tenant`, et que plusieurs ressources sont désormais tenant-scopées.

Le futur modèle ne doit pas simplement remplacer ces chaînes par une table `Role`. Il doit fournir la base d'un système dynamique :

$$\text{Utilisateur} \longrightarrow \text{Membership} \longrightarrow \text{Équipes} \longrightarrow \text{Rôles} \longrightarrow \text{Permissions} \longrightarrow \text{Scope de ressource} \longrightarrow \text{Policies} \longrightarrow \text{Décision}$$

---

## 2. Objectif de cette phase

Produire le modèle de domaine complet nécessaire aux futures phases d'autorisation, en définissant :
* Les rôles et presets
* Les permissions et leur catalogue
* Les équipes (teams)
* Les scopes de ressources
* Les policies
* La stratégie de compatibilité avec `Membership.role`

> **Rappel :** Cette phase ne doit pas encore implémenter le moteur d'autorisation.

---

## 3. Principes d'autorisation

Le modèle doit permettre de représenter :

* **Qui :** Porté par `User`, `Membership`, `Team`
* **Quel rôle :** Porté par `Role`
* **Quelle action :** Porté par `Permission`
* **Sur quelle ressource :** Porté par le scope de ressource
* **Dans quel tenant :** Porté par `Tenant`
* **Sous quelles conditions :** Porté par `Policy`
* **Résultat :** Autoriser ou refuser

> **Principe de sécurité :** Le système suit strictement le **principe du refus par défaut**. Une permission non accordée ne doit jamais être implicitement autorisée.

---

## 4. Rôles

### 4.1 Modèle
Le rôle est une entité persistée en base, appartenant à un tenant identifié. Un rôle d'un tenant ne doit pas être utilisable dans un autre tenant.

### 4.2 Rôle système Root
Un rôle système `Root` sera créé avec le marqueur système actif (`isSystem: true`). Il est techniquement protégé contre :
* La suppression
* Le renommage
* La modification de ses permissions
* L'attribution accidentelle depuis les interfaces normales

À cette phase, il n'est attribué à aucune adhésion existante. Sa sémantique opérationnelle éventuelle sera définie dans une phase ultérieure, au moment de construire l'administration des rôles.

---

## 5. Presets de rôles

Les rôles historiques deviennent des **presets**, marqués comme tels : `Owner`, `Operator`, `Viewer`.

Le moteur ne doit **jamais** contenir de condition écrite en dur du type `if (role === 'owner')`. Ces presets sont simplement des rôles initialement fournis par Hullbay, capables d'évoluer comme n'importe quel autre rôle conformément aux règles d'administration qui seront définies dans les phases suivantes.

---

## 6. Permissions

Une permission est une entité persistée avec une clé unique suivant le format `ressource.action` (par exemple `project.deploy`). 

L'ajout d'une permission doit pouvoir se faire sans modifier la structure de la base de données, et **jamais** sous forme d'énumération TypeScript.

---

## 7. Catalogue de permissions

Ce catalogue est construit à partir de deux sources croisées : une recherche exhaustive des points d'entrée `requireRole` dans le code, et la matrice de rôles déjà établie lors de la phase de découverte. Il couvre les dix fichiers de routes qui appliquent effectivement une garde de rôle. 

| Clé | Ressource | Action | Description | Scope possible |
| :--- | :--- | :--- | :--- | :--- |
| `cluster.read` | Cluster | read | Lire les détails d'un cluster | tenant, cluster |
| `cluster.create` | Cluster | create | Créer un nouveau cluster | tenant |
| `cluster.update` | Cluster | update | Modifier un cluster | cluster |
| `cluster.delete` | Cluster | delete | Supprimer un cluster | cluster |
| `server.read` | Server | read | Lire les détails d'un serveur | cluster, server |
| `server.create` | Server | create | Provisionner un nouveau serveur | cluster |
| `server.delete` | Server | delete | Retirer un serveur du cluster | server |
| `server.promote` | Server | promote | Promouvoir en manager | server |
| `server.demote` | Server | demote | Rétrograder en worker | server |
| `project.read` | Project | read | Lire un projet et son graphe | tenant, cluster, project |
| `project.create` | Project | create | Créer un projet | tenant, cluster |
| `project.update` | Project | update | Modifier un projet | project |
| `project.delete` | Project | delete | Supprimer un projet | project |
| `project.deploy` | Project | deploy | Déclencher un déploiement | project |
| `project.destroy` | Project | destroy | Détruire les ressources déployées | project |
| `project.rebuild` | Project | rebuild | Reconstruire depuis Docker | project |
| `graph.node.create` | Node | create | Ajouter un nœud au canevas | project |
| `graph.node.update` | Node | update | Modifier un nœud | node |
| `graph.node.delete` | Node | delete | Supprimer un nœud | node |
| `graph.edge.create` | Edge | create | Lier deux nœuds | project |
| `graph.edge.update` | Edge | update | Modifier un lien | edge |
| `graph.edge.delete` | Edge | delete | Supprimer un lien | edge |
| `secret.read` | Secret Docker | read | Lire les métadonnées d'un secret | cluster |
| `secret.set` | Secret Docker | set | Créer ou mettre à jour un secret | cluster |
| `secret.delete` | Secret Docker | delete | Supprimer un secret | cluster |
| `registry.read` | RegistryCredential | read | Lire les identifiants de registre | tenant |
| `registry.set` | RegistryCredential | set | Configurer un registre | tenant |
| `registry.delete` | RegistryCredential | delete | Supprimer un registre | tenant |
| `settings.domain.read` | Settings | read | Lire la configuration du domaine | tenant |
| `settings.domain.set` | Settings | set | Modifier le domaine | tenant |
| `audit.read` | AuditLog | read | Consulter le journal d'audit | tenant |
| `logs.read` | Observability | read | Lire l'état de santé, le drift et le placement | tenant, cluster, project |
| `update.check` | SystemUpdate | check | Vérifier les mises à jour | tenant |
| `update.apply` | SystemUpdate | apply | Appliquer une mise à jour | tenant |
| `update.rollback` | SystemUpdate | rollback | Annuler une mise à jour | tenant |
| `update.channel` | SystemUpdate | channel | Changer le canal de mise à jour | tenant |
| `user.read` | User | read | Lister les utilisateurs | tenant |
| `user.create` | User | create | Créer un utilisateur | tenant |
| `user.update` | User | update | Modifier un utilisateur (ex: rôle) | tenant |
| `user.delete` | User | delete | Supprimer un utilisateur | tenant |
| `provider.read` | AuthProvider | read | Lister les fournisseurs d'authentification | tenant |
| `provider.create` | AuthProvider | create | Ajouter un fournisseur d'authentification | tenant |
| `provider.update` | AuthProvider | update | Modifier un fournisseur d'authentification | tenant |
| `provider.delete` | AuthProvider | delete | Supprimer un fournisseur d'authentification | tenant |
| `provider.test` | AuthProvider | test | Tester la connexion d'un fournisseur | tenant |
| `pending.read` | PendingIdentity | read | Lister les identités en attente | tenant |
| `pending.approve` | PendingIdentity | approve | Approuver une identité | tenant |
| `pending.reject` | PendingIdentity | reject | Rejeter une identité | tenant |
| `prune.dry` | Orphan Resources | dry | Lister les ressources orphelines | tenant, cluster |
| `prune.apply` | Orphan Resources | apply | Supprimer les ressources orphelines | tenant, cluster |

> **Note sur `logs.read` :** Le point d'entrée `logs.read`, protégé par une garde de niveau viewer dans le fichier d'observabilité, regroupe pour l'instant la santé du cluster, le drift, et le placement des ressources sous une seule permission. Cette granularité reste provisoire et devra être affinée avant la phase de branchement du moteur si ces trois notions doivent être autorisées indépendamment.

### 7.1 Routes hors du périmètre RBAC (Authentification en libre-service)

Cinq fichiers de routes existent dans le dépôt sans aucune garde `requireRole` :
* `ldap.routes.ts`
* `saml.routes.ts`
* `sso.routes.ts`
* `sessions.routes.ts`
* `webauthn.routes.ts`

Ce n'est pas un oubli de sécurité : c'est cohérent avec le principe d'indépendance entre l'authentification et l'autorisation. Ces routes concernent soit des flux protocolaires publics par nature (initiation et retour d'une connexion), soit la gestion par une personne de ses propres moyens de connexion (clés FIDO2/WebAuthn, sessions ouvertes). Une personne n'a pas besoin d'une permission au sens du catalogue pour agir sur sa propre identité.

> **Point à vérifier :** Il faudra confirmer, en lisant le contenu réel de `sessions.routes.ts`, si un compte administrateur peut aujourd'hui révoquer la session d'un autre compte que le sien. Si c'est le cas, cette action spécifique demandera une permission distincte à ajouter au catalogue.

---

## 8. Matrice des rôles historiques

Cette matrice reproduit exactement le comportement actuel du code tel qu'établi lors de la phase de découverte :

* **Viewer** reçoit :
  * `project.read`, `logs.read`

* **Operator** hérite de Viewer, et reçoit en plus :
  * `project.create`, `project.update`, `project.delete`, `project.deploy`, `project.destroy`, `project.rebuild`
  * `graph.node.create`, `graph.node.update`, `graph.node.delete`
  * `graph.edge.create`, `graph.edge.update`, `graph.edge.delete`
  * `secret.read`, `secret.set`, `secret.delete`
  * `prune.dry`, `audit.read`

* **Owner** hérite d'Operator, et reçoit en plus :
  * `cluster.read`, `cluster.create`, `cluster.update`, `cluster.delete`
  * `server.read`, `server.create`, `server.delete`, `server.promote`, `server.demote`
  * `registry.read`, `registry.set`, `registry.delete`
  * `settings.domain.read`, `settings.domain.set`
  * `update.check`, `update.apply`, `update.rollback`, `update.channel`
  * `user.read`, `user.create`, `user.update`, `user.delete`
  * `provider.read`, `provider.create`, `provider.update`, `provider.delete`, `provider.test`
  * `pending.read`, `pending.approve`, `pending.reject`
  * `prune.apply`

> **Précision :** Cet héritage descriptif sert uniquement à faciliter la lecture. Le script de peuplement ([Section 21](#21-migration-des-données-existantes)) attribuera à chaque preset l'ensemble complet et explicite de ses permissions, sans mécanisme d'héritage réel au niveau de la base de données.

---

## 9. Association rôle vers permission

La table `RolePermission` lie un rôle à une permission. La combinaison du rôle, de la permission, du type de scope et de l'identifiant de scope est **unique** pour éviter les doublons.

---

## 10. Teams

Une équipe (`Team`) appartient à un tenant identifié. Elle est un regroupement de membres auquel des rôles peuvent être associés (ex: équipe *Platform*, équipe *Developers*).

---

## 11. Membres des Teams

La table `TeamMember` lie une équipe à une adhésion (`Membership`), et **jamais directement à un utilisateur (`User`)**. Cela garantit mécaniquement, par la structure même de la base, qu'une personne ne peut jamais rejoindre une équipe d'un tenant où elle n'a pas d'adhésion.

---

## 12. Rôles attribués aux Teams

La table `TeamRole` lie une équipe à un rôle, avec un scope optionnel. Tous les membres de l'équipe héritent alors des permissions du rôle dans le scope correspondant.

---

## 13. Rôles directs

Le modèle permet également d'attribuer un rôle directement à une adhésion, via le nouveau champ optionnel `roleId` présent sur `Membership`. Le rôle direct et les rôles hérités des équipes seront combinés par le futur moteur.

---

## 14. Scope de ressource

Le scope est représenté explicitement par deux colonnes :
1. `scopeType` : le type de ressource visée (ex: `project`, `cluster`, `tenant`).
2. `scopeId` : l'identifiant précis de cette ressource.

Un scope global au tenant utilise un identifiant nul (`null`).

---

## 15. Sémantique du scope

Le modèle distingue :
* **Scope global :** La permission s'applique à toutes les ressources de ce type dans le tenant.
* **Scope de ressource :** La permission ne s'applique qu'à une ressource précise.

> **Principe :** Le scope n'est jamais une hiérarchie implicite. Autoriser un déploiement sur un projet ne donne jamais automatiquement le droit de gérer le cluster qui héberge ce projet.

---

## 16. Relations entre ressources

```text
Tenant
 ├── Membership (relie User et Tenant, porte le rôle historique)
 ├── Cluster
 │     └── Server
 ├── Project
 │     ├── Node
 │     └── Edge
 ├── RegistryCredential
 ├── Settings (relation 1:1)
 ├── AuthProvider (tenant nullable, un fournisseur peut être global)
 ├── SecurityPolicy (relation 1:1)
 └── AuditLog (tenant nullable, un événement système peut n'appartenir à aucun tenant)
```

* **Project $\rightarrow$ Cluster :** Un projet appartient à exactement un cluster.
* **Server $\rightarrow$ Cluster :** Un serveur appartient à exactement un cluster.
* **Node $\rightarrow$ Project :** Un nœud appartient à un projet.
* **Edge $\rightarrow$ Project :** La source et la cible pointent chacune vers un Node du projet.

**Entités globales à l'application entière (hors périmètre d'un tenant précis) :**
`User`, `AuthIdentity`, `WebauthnCredential`, `UserSession`, `PendingIdentity`, `SystemInfo`, `SystemUpdate`.

---

## 17. Secrets

Les secrets ne possèdent pas de table Prisma dédiée : ils vivent dans Docker. Leur autorisation passe par le scope du cluster qui les héberge. Le fait qu'une ressource ne possède pas de table dédiée n'empêche pas de l'autoriser.

---

## 18. Policies et attributs contextuels

Les tables `Policy` et `PolicyBinding` sont créées dès cette phase pour supporter ultérieurement des conditions exprimées en données structurées (ex: autoriser une action uniquement depuis une plage IP ou interdire une action malgré un rôle permissif). La syntaxe exacte du moteur de policy sera définie ultérieurement. Aucun moteur de policy n'est implémenté ici.

---

## 19. Groupes provenant des fournisseurs d'identité

Le modèle `ExternalGroupMapping` est créé pour représenter la correspondance entre un groupe externe (IdP) et une équipe Hullbay. La synchronisation réelle sera implémentée dans une phase ultérieure après vérification des payloads d'authentification. La structure est prête mais reste inactive.

---

## 20. Migration de `Membership.role`

Le champ actuel `Membership.role` reste temporairement présent :
* Si le nouveau champ `roleId` est renseigné, le futur moteur utilise le nouveau rôle.
* S'il reste `null`, le moteur retombe sur l'ancienne chaîne de caractères.

Cette chaîne est un mécanisme hérité qui sera retiré uniquement lorsque toutes les routes auront basculé sur le nouveau modèle (Phase 7).

---

## 21. Migration des données existantes

Le script de peuplement sera **idempotent** et s'exécutera dans cet ordre :
1. Créer toutes les permissions du catalogue si elles n'existent pas encore.
2. Créer les trois presets (`Owner`, `Operator`, `Viewer`) pour chaque tenant concerné.
3. Créer le rôle système `Root` (`isSystem: true`) sans l'attribuer à quiconque.
4. Associer à chaque preset l'ensemble exact des permissions listées à la [Section 8](#8-matrice-des-rôles-historiques).
5. Ne modifier aucune adhésion (`Membership`) existante.

---

## 22. Sécurité tenant

Toutes les relations nouvelles (`Role`, `Team`, `TeamMember`, `TeamRole`, `Policy`, `PolicyBinding`, `ExternalGroupMapping`) sont isolées par tenant. Une opération ne doit jamais permettre à un tenant d'accéder au rôle, à l'équipe, ou au scope d'une ressource appartenant à un autre tenant. Les index et contraintes d'unicité du schéma le garantissent structurellement.

---

## 23. Ce qui ne doit pas être implémenté dans cette phase

* Le moteur d'autorisation lui-même (`authorization.can()`), sous quelque forme que ce soit.
* La migration de l'ensemble des routes existantes.
* La suppression du champ historique `role` sur `Membership`, du champ miroir sur `User`, ou de la garde actuelle.
* L'implémentation réelle du moteur de policy, de la synchronisation des groupes externes, ou des interfaces de gestion.

---

## 24. Modèle Prisma complet

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
  id           String  @id @default(cuid())
  roleId       String
  permissionId String
  scopeType    String?
  scopeId      String?

  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([roleId, permissionId, scopeType, scopeId])
  @@index([roleId])
  @@index([scopeType, scopeId])
}

model Team {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant                Tenant                  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  members               TeamMember[]
  roles                 TeamRole[]
  externalGroupMappings ExternalGroupMapping[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model TeamMember {
  id           String   @id @default(cuid())
  teamId       String
  membershipId String
  joinedAt     DateTime @default(now())

  team       Team       @relation(fields: [teamId], references: [id], onDelete: Cascade)
  membership Membership @relation(fields: [membershipId], references: [id], onDelete: Cascade)

  @@unique([teamId, membershipId])
  @@index([membershipId])
}

model TeamRole {
  id        String  @id @default(cuid())
  teamId    String
  roleId    String
  scopeType String?
  scopeId   String?

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  role Role @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([teamId, roleId, scopeType, scopeId])
  @@index([teamId])
  @@index([scopeType, scopeId])
}

model Policy {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  description String?
  effect      String   // "allow" ou "deny"
  conditions  Json     // structure exacte définie en phase policy
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant   Tenant          @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  bindings PolicyBinding[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model PolicyBinding {
  id        String  @id @default(cuid())
  policyId  String
  roleId    String?
  teamId    String?
  scopeType String?
  scopeId   String?

  policy Policy @relation(fields: [policyId], references: [id], onDelete: Cascade)

  @@index([policyId])
  @@index([roleId])
  @@index([teamId])
}

model ExternalGroupMapping {
  id                String   @id @default(cuid())
  tenantId          String
  providerId        String
  externalGroupName String
  teamId            String
  createdAt         DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  team   Team   @relation(fields: [teamId], references: [id], onDelete: Cascade)

  @@unique([tenantId, providerId, externalGroupName])
  @@index([teamId])
}

// Modification de la table existante
model Membership {
  id        String   @id @default(cuid())
  userId    String
  tenantId  String
  role      String   // conservée, lue tant que roleId est absent
  roleId    String?  // nouvelle référence, nullable
  createdAt DateTime @default(now())

  user        User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  roleRef     Role?        @relation(fields: [roleId], references: [id], onDelete: SetNull)
  teamMembers TeamMember[]

  @@unique([userId, tenantId])
}
```

---

## 25. Critères de validation

La Phase 1 est considérée comme validée lorsque :
1. Le schéma Prisma complet est fourni sans aucun espace réservé.
2. Aucune table ne viole l'isolation par tenant.
3. Toutes les ressources réelles ont été recensées.
4. Le catalogue de permissions provient d'une recherche vérifiée dans le code.
5. Les rôles historiques ne sont plus que des presets.
6. Le rôle `Root` est techniquement protégé.
7. Les rôles et les équipes sont rattachés à un tenant.
8. Les scopes sont définis précisément.
9. Les relations entre ressources sont documentées.
10. La correspondance avec les groupes externes est préparée sans être activée.
11. Le modèle de policy est préparé sans être implémenté.
12. La compatibilité avec l'ancien champ `Membership.role` est assurée.
13. La stratégie de migration reste idempotente sans jamais toucher aux données en place.