## Sécurité — ports d'administration (Docker API, Caddy admin)

Les ports d'administration (2375 pour Docker, 2019 pour Caddy) ne sont
**jamais exposés publiquement**, quel que soit l'état du pare-feu du serveur.
Ils sont publiés sur `127.0.0.1` du serveur distant dès le déploiement
(`-p 127.0.0.1:...`) et hullbay y accède exclusivement via un tunnel SSH, en
réutilisant la clé de maintenance posée pendant le provisioning. Ce
comportement est verrouillé par des tests d'intégration
(provision-server.test.ts).

Aucune action manuelle n'est requise de ta part pour sécuriser ces ports.

**Limite connue** : les tunnels SSH sont ouverts à la demande et gardés en
mémoire du processus API. Un redémarrage de l'API ferme tous les tunnels ;
ils se rouvrent automatiquement au prochain appel vers ce cluster (léger
délai, invisible en usage normal). Si le manager distant devient injoignable
en SSH, ce cluster devient temporairement inaccessible à l'administration —
comportement voulu (voir section sécurité).