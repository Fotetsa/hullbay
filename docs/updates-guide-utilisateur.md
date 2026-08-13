# Mises à jour de l'instance — Guide utilisateur

Ce guide décrit le fonctionnement du système de mises à jour intégré à
l'ops-panel. Il s'adresse au **propriétaire** (owner) de l'instance hullbay :
toutes les actions de mise à jour sont réservées à ce rôle.

## 1. Accéder à la page Mises à jour

Ouvrir l'ops-panel, puis cliquer sur **« Mises à jour »** dans la navigation
latérale (icône flèche circulaire). Le badge bleu « Nouveau » signale qu'une
mise à jour est disponible dès la connexion ; il disparaît après affichage.

Si l'entrée n'apparaît pas dans la navigation : le compte connecté n'est pas
propriétaire (le rôle ne peut pas mettre à jour l'instance).

## 2. La carte Instance

| Élément | Description |
|---|---|
| **Version déployée** | Tag de l'image réellement en cours (source de vérité : conteneur/Swarm). Badge orange « Mise à jour disponible » si une release plus récente existe sur le canal. |
| **Toggle « Version bêta »** | Dans l'en-tête de la page. Désactivé (défaut) : canal `stable` (production). Activé : canal `beta` (pré-releases). Le basculement change immédiatement la version proposée ; chaque bascule est tracée dans « Changements de canal ». |
| **Dernière version disponible** | La release la plus récente (stable ou bêta selon le toggle) plus récente que la version installée, avec sa date. |
| **Mettre à jour** | Visible **uniquement** si une version plus récente existe sur le canal actif. Ouvre la confirmation (voir §3). |
| **Vous êtes à jour** | Affiché quand aucune version plus récente n'existe : aucun bouton de mise à jour. |
| **Dernière vérification** | Date de la dernière interrogation réussie de GitHub. En cas de limite de débit GitHub ou de panne réseau, la ligne indique le mode dégradé et le dernier résultat connu est affiché à la place. |

## 3. Lancer une mise à jour

1. Cliquer sur **« Mettre à jour »** dans la carte Instance.
2. Vérifier la version cible (la dernière du canal actif) dans la confirmation,
   puis **« Confirmer la mise à jour »**.

La mise à jour se déroule automatiquement :

1. Backup PostgreSQL (`pg_dump`) dans le volume `ops_backups` ;
2. Tirage des images `api` et `web` depuis GHCR ;
3. Mise à jour roulante du web puis de l'API ;
4. **Verdict finalisé au redémarrage** de l'API (le processus se remplace lui-même).

Le suivi s'affiche **dans la carte Instance** : étapes avec icônes (sauvegarde,
version, images, interface, API), barre de progression et durée. Pendant le
déploiement, **tous les autres éléments de la page sont désactivés** (toggle,
boutons, historique) pour éviter toute action concurrente, et un rechargement
du navigateur demande une confirmation. Une fois terminé, le verdict s'affiche
(succès, échec ou retour arrière automatique) avec les boutons **« Recharger la
page »** et **« Fermer »**.

La barre n'atteint 100 % qu'une fois l'API redémarrée sur la nouvelle version :
la validation de l'étape **API** est effectuée au redémarrage (le processus se
suicidait avant de pouvoir la cocher).

> ⚠️ Un seul déploiement à la fois. Si une mise à jour est déjà en cours, la
> demande est refusée avec un message explicite.

### Installer une version intermédiaire

Depuis la liste des **Versions publiées**, chaque release plus récente que la
version installée expose un bouton **« Installer cette version »** pour cibler
cette version précise (par ex. passer de `1.2.0` à `1.2.2` sans prendre la
dernière). La mise à jour passe d'abord par la version courante puis rejoint la
version choisie.

## 4. Rollback (retour arrière)

Dans l'**Historique**, une entrée **réussie** expose un bouton **« Rollback »**
(une mise à jour échouée n'a rien à annuler — aucune action disponible) :

1. Cliquer une fois → le bouton devient **« Confirmer le rollback »** (auto-annulation
   après 4 s) ;
2. Confirmer → restauration du dump pré-update puis redéploiement de l'ancienne
   version (web puis API).

Chaque rollback crée sa **propre entrée** dans l'historique (statut
`rolled_back` « Annulé »), et l'entrée d'origine passe dans un état « déjà
annulée » (son bouton disparaît). Un rollback qui échoue (restauration
impossible) reste consultable en `failed` et l'entrée d'origine redevient
annulable.

Le rollback d'un échec de déploiement est **automatique** : si l'API ne
redémarre pas sur le nouveau tag, la finalisation au boot restaure le dump et
l'ancienne image (statut `rolled_back` dans l'historique).

## 5. Historique complet

La section **Historique** liste les mises à jour avec leur statut, les versions
aller/retour, la date et l'erreur éventuelle. Filtrer par statut (Tous /
Réussies / Échouées / Annulées / En cours) et charger davantage d'entrées avec
**« Voir plus »**.

Statuts possibles : `pending` (en attente), `running` (en cours), `success`,
`failed`, `rolled_back` (annulée par rollback manuel ou automatique).

## 6. Canal beta (pré-releases)

Pour tester les versions candidates : activer le toggle **« Version bêta »**
dans l'en-tête de la page. La dernière version proposée et la liste des
versions publiées montrent alors les releases marquées pré-release
(`v1.2.0-beta.1`, `v1.3.0-rc.2`, …). Désactiver le toggle pour revenir aux
versions de production. Le comparateur de versions est le **semver 2.0** :
`1.2.3-beta.10 > 1.2.3-beta.2`, une stable prime sur une pré-release de même
numéro.

## 7. Dépannage express

| Symptôme | Cause probable | Action |
|---|---|---|
| « Vérification impossible » | API injoignable ou erreur interne | Recharger la page ; vérifier l'état de l'API |
| « GitHub 403 — rate-limit » | Quota GitHub 60 req/h dépassé | Réessayer plus tard, ou configurer `GITHUB_TOKEN` (voir guide développeur) |
| Page figée sur « Chargement… » | API pas à jour (réponse `/history` incompatibles) | Redéployer l'API + la web |
| « Une mise à jour est déjà en cours » | Verrou anti-concurrence | Attendre la fin du déploiement |
| « Terminée » mais barre bloquée < 100 % / étape API non cochée | API déployée antérieure au correctif de finalisation (l'étape API n'était validée qu'au redémarrage) | Redéployer l'API ; re-tester sur la prochaine mise à jour |

Voir le [guide de dépannage](updates-troubleshooting.md) pour le détail.
