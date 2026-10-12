# Modèle de domaine d'autorisation

Document technique accompagnant la Phase 1 du chantier d'autorisation de Hullbay. Il décrit uniquement la fondation de données posée à cette étape, le moteur d'autorisation lui-même n'existe pas encore et sera construit dans une phase séparée, après validation de ce modèle.

## 1. Diagramme des entités

Tenant
│
├── Membership (User × Tenant)
│ ├── role (chaîne historique, conservée)
│ └── roleId (nouvelle référence, nullable)
│ │
│ └── Role
│
├── Role
│ ├── isPreset, isSystem
│ └── RolePermission ── Permission (globale, hors tenant)
│
├── Team
│ ├── TeamMember ── Membership
│ ├── TeamRole ── Role
│ └── ExternalGroupMapping ── AuthProvider
│
└── Policy
└── PolicyBinding ── Role | Team


Permission est la seule entité du nouveau modèle qui ne porte pas de tenant, parce qu'elle décrit une capacité générale du système, par exemple `project.deploy`, partagée par construction entre tous les tenants. Toutes les autres nouvelles entités appartiennent à un tenant précis.

## 2. Catalogue des permissions

Le catalogue a été construit à partir d'une recherche réelle des gardes de rôle présentes dans le dépôt, pas depuis une liste d'exemples. Dix fichiers de routes portent une garde de ce type, cinq autres n'en portent aucune et relèvent de l'authentification sur sa propre identité plutôt que d'une autorisation sur une ressource appartenant à un tiers.

Cinquante permissions au total, réparties en neuf familles, cluster, serveur, projet, nœud et lien du canevas, secret Docker, registre, paramètres, système, et compte utilisateur. Chaque permission suit le format ressource point action, par exemple `cluster.delete` ou `project.deploy`, stockée comme donnée en base plutôt que comme énumération dans le code, pour qu'une future permission s'ajoute sans jamais nécessiter de migration structurelle.

Un point reste explicitement ouvert, la permission `logs.read` regroupe aujourd'hui trois notions distinctes, la santé du cluster, le drift, et le placement des ressources, sous une seule et même clé. Cette granularité a été volontairement laissée large à ce stade, faute d'avoir encore examiné le détail fin du fichier de routes concerné, et devra être affinée avant que le moteur ne soit branché dessus si ces trois notions doivent un jour s'autoriser indépendamment les unes des autres.

Un second point reste à vérifier avant le branchement du moteur, l'existence éventuelle d'une route permettant à un administrateur de révoquer la session d'un autre compte que le sien dans le module de sessions. Si une telle route existe, elle sortirait du périmètre de l'authentification en libre-service et mériterait sa propre permission dédiée, non créée à ce stade faute de confirmation.

## 3. Matrice Owner, Operator, Viewer

Cette matrice reproduit exactement le comportement du code existant, établi lors de la phase de découverte, pas une répartition supposée à partir des seuls noms des rôles.

Viewer reçoit deux permissions, `project.read` et `logs.read`.

Operator reçoit l'ensemble des permissions de Viewer, et y ajoute la gestion complète des projets et de leur graphe, création, modification, suppression, déploiement, destruction, reconstruction, les nœuds et les liens du canevas, la gestion des secrets Docker, l'aperçu des ressources orphelines, et la lecture du journal d'audit.

Owner reçoit l'ensemble des permissions d'Operator, et y ajoute tout ce qui touche à l'infrastructure et à l'administration, les clusters, les serveurs, les registres, les paramètres de domaine, les mises à jour du système, la gestion des comptes utilisateurs, les fournisseurs d'authentification, les identités en attente d'approbation, et la suppression effective des ressources orphelines.

Cet enchaînement descriptif sert uniquement à faciliter la lecture. En base, chaque preset reçoit l'ensemble complet et explicite de ses permissions au moment du peuplement, sans aucun mécanisme d'héritage réel entre les trois rôles.

## 4. Sémantique des scopes

Le scope d'une permission accordée à un rôle est représenté par deux colonnes explicites, le type de ressource visé, par exemple tenant, cluster, serveur, projet, nœud, ou lien, et l'identifiant précis de cette ressource. Il n'existe aucune valeur vide pour représenter un scope global, le scope global au tenant s'exprime toujours par un type égal à tenant et un identifiant égal à celui du tenant lui-même. Ce choix garantit une unicité déterministe dans la base, deux colonnes toujours renseignées se comparent et s'indexent simplement, sans cas particulier à traiter pour une valeur absente.

Un scope ne crée jamais de hiérarchie implicite. Autoriser un déploiement sur un projet précis ne donne jamais automatiquement le droit de gérer le cluster qui héberge ce projet, même si cette relation existe réellement entre les deux ressources. Toute relation de ce type devra être exprimée explicitement par le futur moteur d'autorisation, jamais supposée depuis la seule structure des données.

## 5. Règles d'isolation tenant

Chaque relation nouvelle qui touche deux entités appartenant chacune à un tenant repose sur une clé étrangère composite portant à la fois l'identifiant du tenant et l'identifiant de la ressource, jamais sur l'identifiant seul. C'est cette composition qui empêche structurellement, au niveau de la base elle-même et non par une simple vérification applicative contournable, qu'une équipe d'un tenant se retrouve liée au rôle d'un autre tenant, ou qu'une adhésion d'un tenant rejoigne une équipe d'un tenant différent.

Une seule relation du modèle déroge à ce principe, et c'est documenté comme une limite assumée plutôt que contournée en silence. La table de correspondance avec les groupes d'un fournisseur d'identité externe porte une relation simple, non composite, vers ce fournisseur, parce que ce dernier peut être global et partagé entre tous les tenants, auquel cas son propre identifiant de tenant est vide. Une clé composite exigerait une égalité stricte entre les deux tenants, ce qui ne serait jamais vrai pour un fournisseur global, et la base ne sait pas exprimer nativement une contrainte du type égaux ou l'un des deux est vide sans un déclencheur écrit à la main. La règle réelle, le tenant de la correspondance doit soit correspondre à celui du fournisseur, soit le fournisseur doit être global, est donc vérifiée par le service applicatif au moment de la création d'une correspondance, pas par la base.

## 6. Stratégie du rôle Root

Le rôle Root est créé pour chaque tenant au moment du peuplement, avec son marqueur système activé. Il n'est, à ce stade, jamais attribué à aucune adhésion par le script de peuplement : il n'existe que comme un nom réservé et protégé. Aucune interface d'administration future ne pourra le proposer dans une liste de rôles assignables.

La protection est technique et portée par la base, pas seulement par un drapeau. Des triggers PostgreSQL refusent la suppression d'un rôle système, son renommage, le changement de son marqueur ou de son tenant, ainsi que tout ajout, modification ou retrait de ses permissions. La suppression en cascade d'un tenant reste permise, puisque le tenant a déjà disparu au moment où ses rôles sont supprimés.

Sa sémantique opérationnelle définitive, savoir s'il sera un jour attribuable et ce qu'il autoriserait, sera précisée au moment de construire l'administration des rôles, pas avant.

## 7. Stratégie de compatibilité avec le modèle historique

(inchangée)

## 8. Stratégie de migration

Deux migrations sont livrées. La première est strictement additive : aucune table existante n'a perdu de colonne, aucune donnée n'a été modifiée ou supprimée. La seconde durcit le modèle sur ce que Prisma ne sait pas exprimer : clé étrangère de `Membership.roleId` qui ne met à NULL que `roleId` à la suppression d'un rôle, contraintes CHECK sur `PolicyBinding` (au moins un rôle ou une équipe) et sur `Policy.effect` (`allow` ou `deny`), et triggers de protection des rôles système.

Le script de peuplement est idempotent par construction : il retrouve chaque permission par sa clé unique et chaque rôle par son couple tenant et nom, jamais par un identifiant généré, de sorte qu'une exécution répétée ne produit aucun doublon et ne modifie pas ce qui existe déjà.

## 9. Limites de cette phase

Aucun moteur d'autorisation n'a été écrit. Aucune route existante n'a été migrée : toutes continuent de passer par l'ancienne garde de rôle. Aucune interface d'administration n'a été construite. Le contenu des policies (structure des conditions) reste à définir. La synchronisation avec les groupes d'un fournisseur d'identité n'est pas implémentée, seule la structure qui l'accueillera est en place.

Limites assumées :
- Les presets ne sont créés que pour les tenants existants au moment du peuplement. La création d'un nouveau tenant devra les générer dans une phase ultérieure.
- La permission `logs.read` regroupe la santé du cluster, le drift et le placement des projets. Son nom est provisoire et pourra être affiné avant le branchement du moteur.
- Les routes de sessions (`sessions.routes.ts`) ne portent aucune permission : chaque utilisateur n'y agit que sur ses propres sessions, vérifié par propriété. Aucune route ne permet de révoquer la session d'un autre compte.
- La cohérence entre le tenant d'une correspondance de groupe externe et celui de son fournisseur est vérifiée par le service applicatif, car un fournisseur global (tenant vide) ne peut pas être contraint par une clé composite.