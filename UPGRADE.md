# Mise à niveau vers le multi-cluster

## Ce qui change
Un nouveau modèle `Cluster` apparaît. Toute installation existante reçoit
automatiquement un cluster "Default", créé pendant la migration, qui reprend
exactement la configuration réseau déjà en place (`tcp://socket-proxy:2375`,
`http://caddy:2019`) — aucune action requise pour continuer à fonctionner
comme avant.

## Si la migration échoue
1. Vérifie les logs : `docker compose logs api | grep -i migrat`
2. Le cluster "Default" est auto-créé au premier démarrage même si la
   migration a été appliquée avant ce correctif (voir `getDefaultCluster()`)
3. En dernier recours, restaure ta sauvegarde `.env` et la base Postgres
   depuis un backup antérieur à la mise à jour

## Sécurité — nouveaux ports exposés lors de l'ajout d'un cluster
Ajouter un nouveau serveur qui devient le manager d'un nouveau cluster expose
deux ports sur ce serveur : **2375** (Docker API) et **2019** (Caddy admin).
Tu DOIS restreindre ces ports à l'IP de ton serveur hullbay :

```bash
ssh <user>@<ip-du-nouveau-manager>
sudo ufw allow 22
sudo ufw allow from <IP_HULLBAY> to any port 2375 proto tcp
sudo ufw allow from <IP_HULLBAY> to any port 2019 proto tcp
sudo ufw --force enable
```

Sur un fournisseur cloud (AWS, GCP, Azure, OVH), configure **aussi** le
Security Group / pare-feu réseau du fournisseur — un pare-feu OS seul ne
suffit pas sur ces plateformes.