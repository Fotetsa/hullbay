# Conventions d'architecture

Ce document décrit les règles de structuration du code pour garantir la maintenabilité, éviter les cycles d'import et assurer une séparation claire des responsabilités.

## 1. Gestion des événements (Subscribers)

Le choix de l'emplacement d'un subscriber (handler d'événement) repose sur un critère unique et actionnable : **le périmètre d'impact du handler**. 

La question à se poser est : *"Est-ce que ce handler appartient logiquement au domaine du module émetteur, ou orchestre-t-il des interactions entre plusieurs modules ?"*

### A. Subscribers Centralisés (`src/subscribers/<nom>.ts`)
**Quand l'utiliser :** Le handler réagit à un événement métier en touchant **un autre module** que celui qui a émis l'événement.

**Pourquoi :** Centraliser ces handlers évite qu'un module n'importe un autre module "en aval" uniquement pour réagir à ses propres événements, ce qui est la cause principale des cycles d'import (ex: `clusters/` émet un event, `docker-engine/` doit réagir. Si `docker-engine` importait `clusters/`, on créerait une dépendance circulaire).

**Exemples existants :**
- `src/subscribers/clusters.ts` : Écoute `cluster.status` (émis par le workflow de provisioning) pour invalider le cache du module `docker-engine/`.
- `src/subscribers/on-deploy-finished.ts` : Agrège des événements provenant de multiples modules (`deploy`, `destroy`, `server`, `registry`, etc.) pour écrire dans l'`AuditLog` centralisé. Aucun module individuel ne peut légitimement posséder cette logique.

### B. Subscribers Module-local (`src/modules/<nom>/service.ts` ou `subscribers.ts`)
**Quand l'utiliser :** Le handler ne fait que réagir à ses **propres** événements, en ne touchant que l'état ou les services situés à l'intérieur de son propre module (peu importe le fichier exact au sein de ce module).

**Exemple existant :**
- `src/modules/observability/service.ts` : La fonction `registerObservabilitySubscribers()` écoute `drift.detected` et met à jour `driftTracker` (défini dans `observability/drift.ts`) — un fichier voisin, mais toujours à l'intérieur du module `observability/`, jamais un import vers un autre module.

**Exemple existant :**
- `src/modules/observability/service.ts` : La fonction `registerObservabilitySubscribers()` écoute `drift.detected` ou `deploy.finished` uniquement pour mettre à jour le `driftTracker`, qui est un état interne au module d'observabilité.

### C. Règle pratique (Checklist)
Avant de créer un nouveau subscriber, applique ce test :
1. Le corps du handler `import`-t-il un service ou un type d'un module différent de celui qui émet l'événement ? -> **Centralisé**
2. Le handler ne touche-t-il qu'à l'état, aux services ou au cache de son propre module ? -> **Module-local**.

### D. Initialisation
Tous les handlers (qu'ils soient centralisés ou locaux) sont enregistrés une seule fois au démarrage de l'application. Cela se fait dans `src/server.ts`, à l'intérieur du bloc `if (!skipSideEffects)`, via les appels aux fonctions `register*Subscribers()`.

### E. Hors périmètre (Exceptions)
Les écouteurs d'infrastructure qui relaient **tous** les événements sans appliquer de logique métier ne sont pas concernés par cette convention. 
- *Exemple :* `src/loaders/websocket.ts` qui utilise `eventBus.on("*", ...)` pour diffuser les événements aux clients connectés. Ces composants ne "réagissent" pas aux événements, ils les "transportent".

---

## 2. Ajout d'un nouveau module

Lors de la création d'un nouveau module dans `src/modules/` :
1. Isoler la logique métier dans un fichier `service.ts`.
2. Exposer les routes via un fichier `routes.ts`.
3. Si le module doit réagir à des événements **internes**, ajouter la fonction `register[Nom]Subscribers()` dans `service.ts` et l'appeler dans `server.ts`.
4. Ne jamais importer directement `prisma` ou un autre service de module depuis un autre module. Toujours passer par le `service.ts` exporté de ce module.