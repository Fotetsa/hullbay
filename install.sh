#!/usr/bin/env bash
# =============================================================================
# hullbay — installeur one-liner
#
#   curl -fsSL https://raw.githubusercontent.com/fotetsa/hullbay/master/install.sh | bash
#
# Sur un serveur Ubuntu/Debian frais : installe Docker, initialise le Swarm, crée
# l'overlay système, génère les secrets, récupère le compose de prod (images GHCR)
# et démarre l'ops-panel. Idempotent : relançable sans casser une install existante.
#
# Variables d'environnement (optionnelles) :
#   GHCR_OWNER   propriétaire des images GHCR (défaut: fotetsa)
#   IMAGE_TAG    tag d'image (défaut: latest)
#   PUBLIC_HOST  domaine public -> HTTPS auto Let's Encrypt (défaut: vide = HTTP :80)
#   INSTALL_DIR  dossier d'install (défaut: /opt/hullbay)
# =============================================================================
set -euo pipefail

GHCR_OWNER="${GHCR_OWNER:-fotetsa}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/hullbay}"
RAW_BASE="https://raw.githubusercontent.com/${GHCR_OWNER}/hullbay/master"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[hullbay]${NC} $1"; }
warn() { echo -e "${YELLOW}[hullbay]${NC} $1"; }
die()  { echo -e "${RED}[hullbay]${NC} $1" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Lance en root ou installe sudo."
  SUDO="sudo"
fi

# --------------------------------------------------------------------------- #
# 1. Docker (idempotent)
# --------------------------------------------------------------------------- #
if command -v docker >/dev/null 2>&1; then
  log "Docker déjà installé ($(docker --version))."
else
  log "Installation de Docker via le script officiel get.docker.com..."
  curl -fsSL https://get.docker.com | $SUDO sh
fi

# Docker Compose v2 (plugin) requis.
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 absent. Mets Docker à jour (docker compose v2 requis)."
fi

# --------------------------------------------------------------------------- #
# 2. Swarm (idempotent)
# --------------------------------------------------------------------------- #
SWARM_STATE="$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive)"
if [ "$SWARM_STATE" = "active" ]; then
  log "Mode Swarm déjà actif."
else
  ADVERTISE_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
  log "Initialisation du Swarm (advertise-addr=${ADVERTISE_ADDR:-auto})..."
  if [ -n "$ADVERTISE_ADDR" ]; then
    docker swarm init --advertise-addr "$ADVERTISE_ADDR" >/dev/null
  else
    docker swarm init >/dev/null
  fi
fi

# --------------------------------------------------------------------------- #
# 3. Overlay système partagé (Caddy <-> services exposés)
# --------------------------------------------------------------------------- #
if docker network inspect boz_system >/dev/null 2>&1; then
  log "Réseau overlay boz_system déjà présent."
else
  log "Création de l'overlay attachable boz_system..."
  docker network create -d overlay --attachable boz_system >/dev/null
fi

# --------------------------------------------------------------------------- #
# 4. Dossier d'install + fichiers
# --------------------------------------------------------------------------- #
log "Préparation de ${INSTALL_DIR}..."
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO chown "$(id -u):$(id -g)" "$INSTALL_DIR"
cd "$INSTALL_DIR"

log "Récupération du compose de prod et du Caddyfile..."
curl -fsSL "${RAW_BASE}/docker-compose.prod.yml" -o docker-compose.yml
curl -fsSL "${RAW_BASE}/Caddyfile" -o Caddyfile

# --------------------------------------------------------------------------- #
# 5. Génération des secrets (.env) — créé une seule fois, jamais écrasé
# --------------------------------------------------------------------------- #
gen() { openssl rand -hex 32; }
if [ -f .env ]; then
  warn ".env existant conservé (secrets inchangés)."
else
  log "Génération des secrets (.env)..."
  PUBLIC_URL_DEFAULT="http://$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$PUBLIC_HOST" ] && PUBLIC_URL_DEFAULT="https://${PUBLIC_HOST}"
  cat > .env <<EOF
# Généré par install.sh le $(date -u +%FT%TZ). NE PAS committer.
GHCR_OWNER=${GHCR_OWNER}
IMAGE_TAG=${IMAGE_TAG}
PUBLIC_HOST=${PUBLIC_HOST}
PUBLIC_URL=${PUBLIC_URL_DEFAULT}

POSTGRES_USER=ops
POSTGRES_PASSWORD=$(gen)
POSTGRES_DB=bozando_ops

# JWT_SECRET et MFA_ENCRYPTION_KEY = clés MAÎTRESSES. Les perdre = tokens invalides
# et secrets MFA/registre/SSH indéchiffrables. SAUVEGARDE CRITIQUE.
JWT_SECRET=$(gen)
MFA_ENCRYPTION_KEY=$(gen)
EOF
  chmod 600 .env
  warn "SAUVEGARDE .env (JWT_SECRET + MFA_ENCRYPTION_KEY) ailleurs : leur perte = catastrophe."
fi

# --------------------------------------------------------------------------- #
# 6. Démarrage
# --------------------------------------------------------------------------- #
log "Démarrage de l'ops-panel (pull des images GHCR + up)..."
docker compose pull
docker compose up -d

log "Attente de la santé de l'api..."
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

URL="${PUBLIC_HOST:+https://$PUBLIC_HOST}"; URL="${URL:-http://$(hostname -I 2>/dev/null | awk '{print $1}')}"
echo ""
log "Installation terminée."
log "Ouvre : ${URL}"
warn "Crée le compte propriétaire (bootstrap) : POST ${URL}/api/auth/bootstrap {email,password}"
warn "Puis active la MFA dans Paramètres avant d'exposer l'outil sur internet."
