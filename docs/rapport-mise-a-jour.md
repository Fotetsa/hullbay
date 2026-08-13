# Rapport — Mise à jour automatisée de Hullbay

*Document destiné à la direction — présentation du travail réalisé sur le système de mise à jour de l'application.*

---

## 1. Problème

Jusqu'à présent, la mise à jour de l'application Hullbay demandait une intervention manuelle et technique :

- connexion à la machine du client (SSH),
- exécution de commandes de déploiement,
- gestion des bases de données et des éventuels incidents en cours de route.

Ce processus était **lent, risqué et réservé à des personnes techniques**. Un client ne pouvait pas mettre à jour son installation seul, et toute erreur pouvait laisser l'application dans un état instable sans solution simple de retour en arrière.

## 2. Objectif

Donner aux administrateurs de l'application (le « propriétaire » de chaque installation) la possibilité de **mettre à jour Hullbay en quelques clics, depuis l'interface**, de façon fiable et sans risque pour leurs données :

- détecter automatiquement qu'une nouvelle version est disponible,
- lancer la mise à jour,
- suivre le déroulement en temps réel,
- revenir en arrière automatiquement en cas de problème,
- garder la traçabilité de toutes les opérations.

## 3. Solution apportée

### 3.1 Une nouvelle page dédiée : « Mises à jour »

Une page entièrement nouvelle dans l'interface, réservée au propriétaire, qui regroupe :

- la **version actuellement installée** sur l'instance,
- un **toggle « Version bêta »** pour basculer entre les canaux stable et bêta,
- la **dernière version disponible** sur le canal choisi (ou l'état « Vous êtes à jour »),
- un **bouton « Mettre à jour »** — affiché uniquement quand une mise à jour est disponible,
- la possibilité d'**installer une version intermédiaire** depuis la liste des versions publiées,
- l'**historique complet** des mises à jour passées (version de départ, version d'arrivée, date, statut),
- la possibilité de **revenir en arrière** sur une mise à jour déjà réalisée.

### 3.2 Signalement automatique d'une nouvelle version

Une fois connecté, l'administrateur voit immédiatement si une nouvelle version existe grâce à un **badge « Nouveau »** dans la barre latérale, à côté du lien « Mises à jour ». Le badge apparaît dès qu'une mise à jour est disponible et disparaît une fois la page consultée.

La barre latérale affiche également, en permanence, la **version actuelle** de l'application, visible depuis n'importe quelle page.

### 3.3 Un processus de mise à jour automatique et sûr

Lorsque l'administrateur lance la mise à jour, tout se déroule automatiquement, dans l'ordre suivant :

1. **Sauvegarde automatique de la base de données** — avant toute manipulation, l'application crée une copie complète de ses données.
2. **Téléchargement des nouvelles versions** — les nouveaux composants sont récupérés depuis le registre d'images sécurisé.
3. **Remplacement progressif, sans interruption** — le composant web est remplacé en premier (l'interface reste utilisable), puis le composant serveur. Le remplacement est **progressif** (rolling update) : l'ancienne version continue de fonctionner pendant que la nouvelle démarre, et bascule uniquement quand elle est saine.
4. **Vérification finale au redémarrage** — une fois le composant serveur relancé sur la nouvelle version, le système confirme la réussite et enregistre l'opération dans l'historique.

Pendant toute l'opération, le déroulement s'affiche **en direct dans la carte Instance** : étapes à icônes (sauvegarde, version, images, interface, API), barre de progression et durée, puis verdict final. Les autres éléments de la page sont désactivés pendant l'opération, et le navigateur demande confirmation avant tout rechargement.

### 3.4 Sécurité et non-régression

Plusieurs garde-fous garantissent qu'une mise à jour ne casse jamais une installation :

- **Sauvegarde systématique** des données avant chaque mise à jour ;
- **Repli automatique (rollback)** : si le nouveau composant serveur ne redémarre pas correctement sur la nouvelle version, l'application restaure automatiquement la sauvegarde et l'ancienne version — sans intervention humaine ;
- **Repli manuel possible** : l'administrateur peut, à tout moment, revenir en arrière depuis l'historique ;
- **Un seul déploiement à la fois** : impossible de lancer deux mises à jour en parallèle ;
- **Garde anti-retour** : on ne peut pas installer une version plus ancienne que celle en place par accident ;
- **Traçabilité complète** : chaque opération (mise à jour, retour en arrière, changement de canal) est enregistrée et consultable.

## 4. Résultat obtenu

### 4.1 Fonctionnement validé de bout en bout

Le cycle complet a été testé et validé dans des conditions réelles :

- détection de la nouvelle version + affichage du badge « Nouveau »,
- lancement de la mise à jour depuis l'interface,
- déroulement automatique du processus (sauvegarde → remplacement du web → remplacement du serveur → confirmation),
- mise à jour effective de l'installation vers la nouvelle version,
- enregistrement dans l'historique avec le statut « réussi »,
- rollback manuel d'une mise à jour réussie, qui **préserve l'historique** : le
  retour arrière crée sa propre entrée (statut « Annulé ») liée à la mise à
  jour d'origine, et un rollback échoué laisse l'entrée d'origine annulable
  (nouvelle tentative possible).

### 4.2 Tests réalisés dans un environnement isolé

Pour valider le fonctionnement **sans aucun risque pour un environnement de production réel**, nous avons mis en place un **environnement de test complètement isolé dans des conteneurs Docker** sur une machine dédiée :

- une installation de démonstration de Hullbay, avec une **ancienne version**,
- une **version plus récente** mise à disposition dans le registre d'images local,
- l'application a ensuite été **mise à jour manuellement depuis l'interface**, exactement comme le ferait un client.

Ce banc de test nous a permis de :

- vérifier le **processus complet de mise à jour** (déclenchement, suivi en direct, confirmation),
- confirmer que **l'interface et les données restent intactes** après l'opération (non-régression),
- **simuler des erreurs** (échec de téléchargement, version cible indisponible) pour vérifier que l'application les gère proprement et s'arrête sans rien casser,
- corriger plusieurs anomalies découvertes pendant ces essais (affichage de la progression, gestion des journaux), désormais résolues.

### 4.3 Captures d'écran

> *(Captures d'écran à insérer : badge « Nouveau » + version dans la barre latérale, page Mises à jour, fenêtre de confirmation de la mise à jour, suivi en direct dans la carte avec barre de progression, historique des mises à jour.)*

---

## Conclusion

Le système de mise à jour intégré rend l'administration de Hullbay **simple, sûre et autonome** : un administrateur met à jour son installation en quelques clics, avec sauvegarde automatique et retour en arrière garanti en cas d'incident. L'ensemble a été validé de bout en bout dans un environnement isolé, et les cas d'erreur ont été traités afin de garantir la **non-régression** des installations existantes.
