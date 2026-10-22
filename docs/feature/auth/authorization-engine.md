# Authorization Engine, Phase 2

Moteur de décision `can()` / `require()`. Il n'est appelé par aucune route : le branchement est la Phase 3.

## Architecture
catalog/ (structure des ressources), engine/ (logique pure, sans Prisma ni Fastify), repositories/ (interfaces, mémoire, Prisma), authorization.service.ts (façade), index.ts (instance Prisma, seul fichier qui touche la base).

## Algorithme
permission connue, adhésion dans le tenant, ressource chargée et du bon type, tenant de la ressource égal à celui du sujet, rassemblement des sources (rôle direct, rôles d'équipe, repli legacy), filtre sur la permission, filtre sur le scope, policies (un deny l'emporte), décision avec les sources. Toute exception donne un refus.

## Règles
Union de tous les rôles. Le scope tenant couvre tout le tenant et est toujours accepté ; un scope plus étroit n'est accepté que s'il figure dans le catalogue pour cette permission (c'est ce qui autorise la couverture cluster vers projet). Une action sans ressource n'est couverte que par le scope tenant. Pour un rôle d'équipe, la ressource doit être couverte à la fois par le scope de la permission du rôle et par le scope d'attribution de l'équipe (intersection). Root n'a aucun traitement spécial. Aucun cache : tout est relu à chaque appel.

## Repli legacy
Dette isolée dans `engine/legacy-role-resolver.ts`, retirée en Phase 7. Si `roleId` est vide, la chaîne historique est transformée en nom de preset puis le repository cherche un rôle preset de ce nom. Si `roleId` est renseigné mais ne se résout plus, aucun repli : refus.

## Limites
Policies : point d'extension seulement. Aucun audit des refus (Phase 9). `tenant_mismatch` et `resource_not_found` sont distincts dans la décision : la couche route devra répondre de façon uniforme pour ne pas révéler l'existence d'une ressource d'un autre tenant.

## Contrat de sécurité du Subject
`subject.tenantId` est un contexte de sécurité issu de la session authentifiée (UserSession, claim signé), jamais de req.body, req.params ni req.query. Le seul chemin prévu pour construire un Subject est `subjectFromSession(req.user)`. En Phase 3, les routes l'utilisent obligatoirement ; un tenant venant du client ne peut qu'être comparé au tenant authentifié, jamais le remplacer.

## Convention du scope tenant
Représentation canonique unique : `scopeType = "tenant"`, `scopeId = <tenantId>`. Pas de `scopeId = null`. Documentée dans `scope.ts`.

## Cross-scope
Être dans le même tenant ne franchit jamais un scope plus étroit : la ressource doit être couverte par le scope de la permission, et pour un rôle d'équipe aussi par son périmètre d'attribution (intersection). Verrouillé par des tests négatifs (cluster A vers projet B, projet A vers projet B, attribution d'équipe sur projet A vers projet B).

## require()
Simple wrapper de `can()` : mêmes décisions, `ForbiddenError` porte la décision complète (reason et sources).