# Authorization Administration, Phase 4

API d'administration de l'autorisation : rôles, équipes, attributions et permissions effectives. Elle rend le système dynamique : un administrateur crée un rôle comme « Security Auditor » ou « Project Developer » sans modifier le code. Chaque route passe par le moteur (`requirePermission`), sans exception « owner ».

## 1. Périmètre

**Inclus :** CRUD, clonage et permissions/scopes des rôles ; équipes, membres et rôles d'équipe ; rôle direct d'une adhésion ; permissions effectives avec provenance ; 12 nouvelles permissions (catalogue 60 vers 72) ; anti-escalade et anti-verrouillage ; création des presets d'un tenant ; branchement des 13 routes du domaine backup sur le moteur.

**Exclus :** interface (Phase 8) ; policies (Phase 5) ; groupes IdP (Phase 6) ; suppression de `requireRole`, `Membership.role`, `User.role` (Phase 7) ; audit enrichi, y compris des refus (Phase 9) ; administration de Root.

## 2. Architecture

```
modules/authorization/
├── presets.mjs / presets.d.mts   modèles de presets (données) et logique de peuplement,
│                                 partagés par le seed, sync-catalog et la réparation
├── engine/explain.ts             explain(), holds(), rightCovers() (purs)
├── admin/
│   ├── role.service.ts, team.service.ts, assignment.service.ts, effective.service.ts
│   ├── guards.ts                 anti-escalade, anti-verrouillage, protections
│   ├── validation.ts, errors.ts, tx.ts, tenant-presets.ts
│   └── routes.ts                 seul fichier Fastify
└── scripts/ seed-authorization.mjs, sync-catalog.mjs
```

`engine/` reste pur. Les services d'administration sont testés en intégration sur la vraie base, car le verrou consultatif et la concurrence ne se simulent pas.

## 3. Nouvelles permissions (60 vers 72)

Toutes de niveau tenant (scope `tenant:<tenantId>`).

| Clé | Usage |
|---|---|
| `role.read` | lister/lire les rôles et le catalogue |
| `role.create` | créer et cloner un rôle |
| `role.update` | modifier nom, description, permissions et scopes |
| `role.delete` | supprimer un rôle |
| `team.read` / `team.create` / `team.update` / `team.delete` | gestion des équipes |
| `team.member.assign` | ajouter / retirer un membre |
| `team.role.assign` | attribuer / révoquer un rôle d'équipe avec scope |
| `membership.role.assign` | attribuer / retirer le rôle direct d'une adhésion |
| `authorization.read` | permissions effectives d'un autre utilisateur |

Presets : Viewer 4, Operator 25, Owner 72, Root 0. Seul Owner reçoit les permissions d'administration.

## 4. Routes (20 gardées + 1 ouverte, préfixe `/api/authorization`)

| Route | Permission |
|---|---|
| GET `/roles`, `/roles/:id`, `/permissions` | `role.read` |
| POST `/roles`, `/roles/:id/clone` | `role.create` |
| PATCH `/roles/:id`, PUT `/roles/:id/permissions` | `role.update` |
| DELETE `/roles/:id` | `role.delete` |
| GET `/teams`, `/teams/:id` | `team.read` |
| POST `/teams` / PATCH `/teams/:id` / DELETE `/teams/:id` | `team.create` / `team.update` / `team.delete` |
| POST `/teams/:id/members`, DELETE `/teams/:id/members/:membershipId` | `team.member.assign` |
| POST `/teams/:id/roles`, DELETE `/teams/:id/roles/:assignmentId` | `team.role.assign` |
| PUT, DELETE `/memberships/:id/role` | `membership.role.assign` |
| GET `/users/:id/effective-permissions` | `authorization.read` |
| GET `/me/effective-permissions` | authentification seule |

`PUT /roles/:id/permissions` remplace l'ensemble `permission + scope` en une transaction. Les corps de réponse ne contiennent jamais `reason` ni `sources` d'un refus. Le tenant vient uniquement de la session ; un identifiant d'un autre tenant donne le même 404 qu'un identifiant inexistant.

## 5. Règles de sécurité

1. **Anti-escalade.** On n'accorde (à un rôle, une équipe ou une adhésion) que des droits que l'on possède, dans un périmètre au moins aussi large. Pour un remplacement de permissions, seuls les droits ajoutés sont contrôlés. Pour une équipe, ajouter un membre ou attribuer un rôle exige de posséder les droits conférés.
2. **Anti-verrouillage.** Un administrateur est une adhésion avec `role.update` et `membership.role.assign` au scope tenant. Aucune opération ne peut faire passer leur nombre de plus de zéro à zéro (409 `would_lock_out_tenant`). Le contrôle se fait dans la transaction, après la mutation, et l'annule en cas de violation. Toutes les écritures d'un tenant sont sérialisées par `pg_advisory_xact_lock`.
3. **Suppression d'un rôle attribué** refusée (409 `role_in_use`, avec les nombres d'attributions) : sans cela, la clé étrangère remettrait `roleId` à NULL et le moteur retomberait sur les droits historiques.
4. **Root** : aucune route ne le modifie, supprime, clone, ne lui ajoute de permission ni ne l'attribue (409 `system_role`). Les triggers de la Phase 1 restent la dernière protection.
5. **Presets** : modifiables et clonables. Renommage et suppression refusés (409 `preset_in_legacy_use`) tant qu'une adhésion du tenant a `roleId` NULL, car le repli legacy résout ces noms.
6. **Validation.** Chaque permission existe dans le catalogue ; chaque scope est accepté par la permission et désigne le tenant ou une ressource du tenant (`scopeId` jamais NULL) ; noms de 1 à 64 caractères, uniques par tenant (409) ; plafonds de 200 droits par rôle et 100 attributions par équipe.
7. **Legacy.** `POST /api/users/:id/role` écrit toujours `Membership.role`. Les réponses d'attribution d'un rôle direct incluent `legacyRole` et `diverges`. Retirer le rôle direct ramène l'adhésion au rôle historique.

## 6. Permissions effectives

`explain()` réutilise `resolveGrants` et `scopeCovers` du moteur : aucune règle nouvelle. Chaque droit est retourné avec sa provenance (`direct`, `team` + équipe + périmètre d'attribution, `legacy`) et le rôle d'origine. Un test vérifie la cohérence : `can()` autorise si et seulement si `explain()` contient un droit qui couvre.

## 7. Presets d'un tenant

Aucun code applicatif ne crée de tenant. La garantie repose sur `createTenantPresets`/`ensureTenantPresets`, idempotentes (un rôle existant n'est jamais retouché), utilisées par le seed, `sync-catalog` et la réparation au démarrage. Si `AUTHZ_AUTO_PRESETS=true`, le démarrage répare les tenants sans presets ; sinon il alerte seulement (défaut).

**`sync-catalog`** (`npm run sync:catalog`) ajoute les 12 permissions d'administration au preset Owner **non modifié** de chaque tenant. Un Owner personnalisé est laissé tel quel et signalé. Le script ne retire jamais rien. Un preset existant n'est jamais réinitialisé par le seed (V3 §31).

## 8. Événements

Émis sur le bus existant (acteur, tenant, identifiants, résumé, jamais de secret) : `role.created`, `role.updated`, `role.deleted`, `role.cloned`, `team.created`, `team.updated`, `team.deleted`, `team.member.added`, `team.member.removed`, `team.role.assigned`, `team.role.revoked`, `membership.role.assigned`, `membership.role.revoked`. Leur enregistrement dans `AuditLog` est traité en Phase 9.

## 9. Routes backup

Les 13 routes de `backup/routes.ts` passent par `requirePermission` avec les actions du catalogue (lecture : `backup.policy.read` / `backup.artifact.read`, écriture : `backup.policy.create/update/delete`, exécution : `backup.run`, destination : `backup.destination.set`, restauration : `backup.artifact.restore`). En mode `legacy` le comportement est inchangé.

Limites : ces routes désignent des cibles, policies et artifacts, pas des nœuds ; aucune ressource n'est passée, donc seul un scope tenant donne accès. Le preset Viewer possède les deux permissions de lecture backup alors que le legacy exige `operator` : en `enforce`, un viewer pourrait lire policies et artifacts. Cette divergence apparaît en `shadow` et doit être tranchée avec l'équipe backup.

## 10. Tests

- `explain.unit.test.ts` : provenance, `holds` (cluster couvre ses projets, intersection d'équipe), cohérence avec `can()`.
- `admin.integration.test.ts` (vraie base) : scénario de la mission (équipe Backend, rôle Project Developer limité à deux projets, ALLOW sur A et B, DENY sur C et sur `cluster.update`), « Security Auditor », clonage, anti-escalade, Root intouchable, rôle attribué, presets legacy, cross-tenant, anti-verrouillage, concurrence (un seul retrait réussit), retour au rôle historique, tenant créé en base (72 / 25 / 4 / 0), `sync-catalog` idempotent.
- `lot-f-parity.test.ts` : 20 routes gardées, mêmes codes en `legacy`, `shadow` et `enforce`, aucune divergence.
- `architecture.test.ts` : `engine/` et `http/` sans Prisma ; `admin/` hors `routes.ts` sans Fastify ; catalogue de 72 permissions égal aux clés de `presets.mjs`.

## 11. Points ouverts

1. Lecture backup du viewer en `enforce` (section 9).
2. Les routes backup n'acceptent pas de scope plus étroit que le tenant.
3. Audit persistant des événements d'administration et des refus : Phase 9.
4. `explain()` n'a aucun cache : à mesurer sur de gros tenants.
5. Une permission ajoutée plus tard au catalogue n'atteint pas les presets existants sans une nouvelle étape de type `sync-catalog`.

## 12. Rollout et retour arrière

En `legacy`, seul l'owner historique accède à l'administration ; rien ne change pour les autres. Déploiement : `seed:authorization`, `sync:catalog`, vérification du journal de démarrage, puis `shadow`, puis `enforce`. Retour arrière : `AUTHZ_MODE=legacy` et redémarrage. Les rôles, équipes et attributions créés restent valides ; les 12 permissions ajoutées sont sans effet si elles ne sont pas utilisées.