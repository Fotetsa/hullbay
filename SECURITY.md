# Politique de sécurité

## Surface de risque

hullbay pilote un cluster  Docker Swarm. L'accès au démon Docker équivaut à un
contrôle **root** sur les serveurs du cluster. Mesures en place :

- **docker-socket-proxy** (Tecnativa) entre l'api et le socket : seules les API
  Swarm utiles sont autorisées (services, réseaux, volumes, tasks, nodes, events,
  images, secrets). `EXEC` et les écritures conteneur brutes sont **bloquées**.
- **Garde œuf-poule** : toute opération destructive sur une ressource
  `bozando.system=true` (l'ops-panel lui-même) est refusée par le moteur.
- **MFA TOTP** obligatoire + JWT à audiences séparées (session vs mfa-pending).
- **Secrets chiffrés** au repos (AES-256-GCM) : clés SSH-outil, tokens registre.
  Les Docker Secrets applicatifs sont chiffrés par Swarm (Raft) et montés en
  fichiers — jamais dans les labels ni l'env.
- **Bind loopback + Caddy** : l'api n'est jamais exposée directement.
- **Rédaction des logs** : credentials/tokens/valeurs de secrets censurés.
- **Clé/mot de passe SSH personnel** : en mémoire uniquement durant le
  provisioning, jamais persisté ni journalisé.

## Clés maîtresses

`JWT_SECRET` et `MFA_ENCRYPTION_KEY` chiffrent/signent tout le reste. Leur perte
rend les tokens invalides et les secrets indéchiffrables. **À sauvegarder hors du
serveur.** Ne jamais les changer après mise en service.

## Signaler une vulnérabilité

Ne pas ouvrir d'issue publique pour une faille de sécurité. Contacter en privé le
mainteneur (voir le profil GitHub du dépôt). Divulgation responsable appréciée :
laisser un délai raisonnable de correction avant publication.
