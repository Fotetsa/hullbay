# Authorization Enforcement, Phase 3

Branchement du moteur d'autorisation (Phase 2) sur les routes HTTP de Hullbay. Chaque opération sensible est vérifiée côté serveur par `authorization.can()`, avant l'action, à partir du tenant authentifié. Les anciennes gardes `requireRole` restent en place et servent de mode de repli jusqu'à la Phase 7.

## 1. Périmètre

**Inclus :** la garde HTTP `requirePermission`, les extracteurs de ressource, les trois modes de déploiement, la vérification des presets au démarrage, et la migration de 62 routes réparties sur 12 fichiers.

**Exclus :** suppression de `requireRole`, `Membership.role`, `User.role` et du repli legacy (Phase 7) ; administration des rôles et équipes (Phase 4) ; évaluation des policies (Phase 5) ; persistance des refus dans `AuditLog` (Phase 9) ; routes d'authentification en libre-service (ldap, saml, sso, sessions, webauthn et les routes de `auth.routes.ts` hors `/api/audit`) ; jobs de fond.

## 2. Architecture

```
modules/authorization/http/
├── require-permission.ts   garde Fastify (preHandler)
├── resolvers.ts            fromParam, fromBody, fromBodyIfPresent
├── response.ts             décision du moteur vers code HTTP
├── mode.ts                 legacy | shadow | enforce
├── shadow-report.ts        détection des divergences legacy / moteur
└── index.ts                seul fichier qui branche l'instance Prisma réelle
modules/authorization/startup-check.ts   journal du mode et alerte presets manquants
```

`engine/` reste pur (aucun import Prisma, Fastify ni auth). `http/` ne connaît pas Prisma, sauf `http/index.ts` qui injecte le moteur réel. Un test d'architecture le vérifie.

## 3. La garde `requirePermission`

```ts
requirePermission(action, { resource?, legacyMin })
```

- `action` : clé de permission du catalogue (ex. `project.deploy`).
- `resource` : extracteur qui retrouve `{ type, id }` depuis la requête. Absent pour une action de niveau tenant.
- `legacyMin` : seuil de l'ancienne garde, **transitoire**, retiré en Phase 7.

Déroulement (mode `enforce`) :

1. Pas de `req.user` : 401.
2. `subjectFromSession(req.user)` : le Subject vient uniquement du claim signé de la session. Session sans tenant : 401 `session_invalid`.
3. Si `req.tenantId` (tenant effectif des données, éventuellement issu de `x-tenant-id`) diffère du tenant de la session : refus 403 journalisé (`context_tenant_mismatch`). On n'autorise jamais avec un tenant et on ne lit pas les données d'un autre.
4. Extraction de la ressource, puis `can({ subject, action, resource })`.
5. Autorisé : la décision est attachée à `req.authzDecision` (raison et sources, côté serveur uniquement) et la route continue.
6. Refusé : réponse selon la section 5.

Toute erreur interne (extracteur, repository, moteur) est un refus (fail closed).

Le `Subject` est un type « brandé » : un littéral `{ userId, tenantId }` n'est pas assignable. Seul `subjectFromSession` le produit en production, `testSubject` dans les tests.

## 4. Modes de déploiement

Variable `AUTHZ_MODE`, lue une fois au démarrage.

| Mode | Comportement |
|---|---|
| `legacy` | `requireRole` décide et répond lui-même (réponse, audit `auth.tenant_forbidden` et code `tenant_forbidden` inchangés). Le moteur n'est pas appelé. |
| `shadow` | Le legacy décide ; le moteur est évalué en parallèle sans jamais changer la réponse ; toute divergence est journalisée. |
| `enforce` | Le moteur décide. Le legacy n'est plus consulté. |

Valeur absente ou inconnue : `enforce` (jamais `legacy`, fail closed). Exception : sous `NODE_ENV=test`, une valeur absente vaut `legacy`, pour que les suites de routes existantes restent inchangées. Le premier déploiement fixe `AUTHZ_MODE=legacy` explicitement (`.env`, `.env.template`, compose).

**Divergences journalisées en shadow** (journal structuré : route, méthode, action, sujet, tenant, résultats legacy et moteur, raison) :
- `engine_stricter` (niveau `warn`) : le legacy autorise, le moteur refuse. Risque de verrouillage d'un utilisateur légitime, par exemple preset manquant.
- `engine_more_permissive` (niveau `error`) : le legacy refuse, le moteur autorise. Escalade potentielle. **Une seule occurrence bloque le passage en `enforce`.**

## 5. Réponses HTTP

| Décision du moteur | Réponse |
|---|---|
| autorisé | la route continue |
| `no_grant`, `scope_not_covered`, `policy_denied`, `no_membership`, `internal_error` | 403 `{ error: "permission insuffisante" }` |
| `resource_not_found`, `tenant_mismatch`, `invalid_resource` | 404 `{ error: "ressource introuvable" }`, identique dans les trois cas |
| `unknown_permission` | 500 et log d'erreur (action absente du catalogue) |

Le corps ne contient jamais `reason` ni `sources`. Le 404 est uniforme : il est impossible de distinguer une ressource inexistante d'une ressource d'un autre tenant.

## 6. Table des 62 routes

Toutes les actions de niveau tenant sont couvertes par un scope `tenant:<tenantId>` (cas des presets). Les routes avec ressource acceptent aussi un scope plus étroit, selon le catalogue.

**Observabilité (legacy viewer)**

| Route | Action | Ressource |
|---|---|---|
| GET `/api/health/cluster` | `logs.read` | tenant |
| GET `/api/services/:id/metrics` | `logs.read` | tenant (l'identifiant est un `dockerId`) |
| GET `/api/drift` | `logs.read` | tenant |
| GET `/api/projects/:id/placement` | `logs.read` | project |

**Projets (legacy operator, lectures viewer)**

| Route | Action | Ressource |
|---|---|---|
| GET `/api/projects` | `project.read` | tenant |
| GET `/api/projects/:id` | `project.read` | project |
| POST `/api/projects` | `project.create` | cluster si `clusterId` fourni, sinon tenant |
| PATCH `/api/projects/:id` | `project.update` | project |
| DELETE `/api/projects/:id` | `project.delete` | project |
| POST `/api/projects/:id/nodes` | `graph.node.create` | project |
| POST `/api/nodes/:nodeId` | `graph.node.update` | node |
| DELETE `/api/nodes/:nodeId` | `graph.node.delete` | node |
| POST `/api/projects/:id/edges` | `graph.edge.create` | project |
| POST `/api/edges/:edgeId` | `graph.edge.update` | edge |
| DELETE `/api/edges/:edgeId` | `graph.edge.delete` | edge |

**Secrets (legacy operator)**

| Route | Action | Ressource |
|---|---|---|
| GET `/api/clusters/:clusterId/secrets` | `secret.read` | cluster |
| POST `/api/clusters/:clusterId/secrets` | `secret.set` | cluster |
| POST `/api/clusters/:clusterId/secrets/batch` | `secret.set` | cluster |
| DELETE `/api/clusters/:clusterId/secrets/:name` | `secret.delete` | cluster |

**Reconciler**

| Route | Action | Ressource | Legacy |
|---|---|---|---|
| GET `/api/projects/:id/plan` | `project.read` | project | viewer |
| GET `/api/projects/:id/nodes/:nodeId/preview` | `project.read` | project | viewer |
| POST `/api/projects/:id/deploy` | `project.deploy` | project | operator |
| POST `/api/projects/:id/destroy` | `project.destroy` | project | operator |
| POST `/api/rebuild-from-docker` | `project.rebuild` | tenant | operator |
| GET `/api/prune` | `prune.dry` | tenant | operator |
| POST `/api/prune` | `prune.apply` | tenant | owner |

**Clusters et serveurs (legacy owner)**

| Route | Action | Ressource |
|---|---|---|
| GET `/api/clusters` | `cluster.read` | tenant |
| GET `/api/clusters/:id` | `cluster.read` | cluster |
| DELETE `/api/clusters/:id` | `cluster.delete` | cluster |
| GET `/api/servers` | `server.read` | tenant |
| POST `/api/servers` | `server.create` (+ `cluster.create` si `newClusterName`) | cluster si `clusterId` fourni |
| DELETE `/api/servers/:id` | `server.delete` | server |
| POST `/api/servers/:id/role` | `server.promote` si `role=manager`, sinon `server.demote` | server |

**Administration (legacy owner, sauf audit)**

| Route | Action |
|---|---|
| GET `/api/registry` | `registry.read` |
| POST `/api/registry` | `registry.set` |
| DELETE `/api/registry/:id` | `registry.delete` |
| GET `/api/settings/domain` | `settings.domain.read` |
| POST `/api/settings/domain` | `settings.domain.set` |
| GET `/api/settings/webauthn` | `settings.domain.read` (voir section 9) |
| POST `/api/settings/webauthn` | `settings.domain.set` (voir section 9) |
| GET `/api/updates/check`, `/current`, `/history`, `/status/:id` | `update.check` |
| PUT `/api/updates/channel` | `update.channel` |
| POST `/api/updates/apply` | `update.apply` |
| POST `/api/updates/:id/rollback` | `update.rollback` |
| GET `/api/users` | `user.read` |
| POST `/api/users` | `user.create` |
| POST `/api/users/:id/role` | `user.update` |
| DELETE `/api/users/:id` | `user.delete` |
| GET `/api/auth/admin/providers` | `provider.read` |
| POST `/api/auth/admin/providers` | `provider.create` |
| PUT `/api/auth/admin/providers/:id` | `provider.update` |
| DELETE `/api/auth/admin/providers/:id` | `provider.delete` |
| POST `/api/auth/admin/providers/:id/test` et `/preflight` | `provider.test` |
| GET `/api/auth/admin/pendings` | `pending.read` |
| POST `/api/auth/admin/pendings/:id/approve` | `pending.approve` |
| POST `/api/auth/admin/pendings/:id/reject` | `pending.reject` |
| GET `/api/auth/admin/tenants` | `pending.approve` |
| GET `/api/audit` | `audit.read` (legacy operator) |

## 7. Changements de comportement en `enforce`

Le mode `legacy` ne change rien. En `enforce` :

- Les lectures de projets, plan et preview, jusqu'ici ouvertes à tout utilisateur authentifié, exigent `project.read`. Les trois presets la possèdent : aucun rôle historique ne perd d'accès. Seul un utilisateur sans rôle valide est désormais refusé.
- Un `x-tenant-id` différent du tenant de la session est refusé. Le changement de tenant passe par `POST /api/auth/session/switch-tenant`, qui réémet un token signé.
- Une ressource introuvable ou d'un autre tenant renvoie `{"error":"ressource introuvable"}` (404) au lieu des messages propres à chaque route (par exemple « project not found »). Le statut est inchangé.
- Un rôle limité à une ressource (projet, cluster, serveur) ne voit pas les routes de liste de niveau tenant (`GET /api/clusters`, `GET /api/servers`, `GET /api/projects`). Un filtrage par élément est un chantier ultérieur.

## 8. Tests

- `http-guard.test.ts` : garde, modes, tenant, fail closed, shadow, résolution du mode.
- `lot-a`, `lot-b`, `lot-c`, `lot-d` `-parity.test.ts` : sur les vraies routes, mêmes codes HTTP en `legacy`, `shadow` et `enforce` pour owner, operator et viewer, zéro divergence journalisée, matrice attendue, scope sur de vraies routes (projet, cluster, serveur), 404 uniforme, anti-verrouillage (le preset Owner passe les 29 routes d'administration), et un rôle « Security Auditor » créé comme donnée, sans modification du code.
- `architecture.test.ts` : `engine/` et `http/` n'importent pas Prisma ; aucun nom de rôle historique hors du résolveur legacy.

Les tests de parité neutralisent la lecture de la membership en base (les utilisateurs de test n'existent pas) : la parité avec la résolution réelle se vérifie en `shadow` sur un environnement réel.

## 9. Points ouverts

1. **WebAuthn** : mappé sur `settings.domain.*` pour ne pas modifier le catalogue de 50 permissions validé en Phase 1. Alternative : `settings.webauthn.read/set` (52 permissions, seed et preset Owner à étendre).
2. **`GET /api/auth/admin/tenants`** liste tous les tenants sans filtre (comportement existant, conservé). À restreindre au tenant courant.
3. **`update.*`** agit sur l'installation entière mais est autorisé au niveau d'un tenant : tout tenant disposant de `update.apply` peut mettre à jour l'instance. À traiter avant une vraie multi-tenance.
4. **`user.update`** : le changement de rôle modifie encore `Membership.role` ; le moteur ne lit cette chaîne que si `roleId` est vide. À traiter en Phase 4.
5. **`graph.node.*` / `graph.edge.*`** n'acceptent que les scopes `node` / `edge` (catalogue V3) : un rôle limité à un projet ne peut pas modifier ses nœuds. Les presets (scope tenant) ne sont pas concernés.
6. **`logs.read`** couvre santé, drift et placement. Son découpage reste à décider.
7. **Presets** : un tenant créé après le dernier `seed:authorization` n'a pas de presets, donc ses utilisateurs seraient refusés en `enforce`. Le démarrage le signale ; la création automatique à la création d'un tenant reste à faire.

## 10. Rollout et retour arrière

1. Déployer avec `AUTHZ_MODE=legacy` (aucun effet).
2. Exécuter `npm run seed:authorization` sur chaque base. Le journal de démarrage ne doit signaler aucun tenant sans presets.
3. Passer en `shadow` et observer les journaux pendant une période suffisante. Toute divergence `engine_more_permissive` doit être analysée et corrigée avant de continuer.
4. Passer en `enforce`.

**Retour arrière :** remettre `AUTHZ_MODE=legacy` et redémarrer. Aucune migration ni perte de données ; le code legacy reste en place jusqu'à la Phase 7.