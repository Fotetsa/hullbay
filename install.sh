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

# Toutes les commandes docker passent par $SUDO (ou root) : un utilisateur
# non-root avec sudo n'a pas besoin du groupe docker pour installer.
DOCKER="$SUDO docker"

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
if ! $DOCKER compose version >/dev/null 2>&1; then
  die "Docker Compose v2 absent. Mets Docker à jour (docker compose v2 requis)."
fi

# --------------------------------------------------------------------------- #
# 2. Swarm (idempotent)
# --------------------------------------------------------------------------- #
SWARM_STATE="$($DOCKER info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo inactive)"
if [ "$SWARM_STATE" = "active" ]; then
  log "Mode Swarm déjà actif."
else
  ADVERTISE_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
  log "Initialisation du Swarm (advertise-addr=${ADVERTISE_ADDR:-auto})..."
  if [ -n "$ADVERTISE_ADDR" ]; then
    $DOCKER swarm init --advertise-addr "$ADVERTISE_ADDR" >/dev/null
  else
    $DOCKER swarm init >/dev/null
  fi
fi

# --------------------------------------------------------------------------- #
# 3. Overlay système partagé (Caddy <-> services exposés)
#    Vérifie l'EXISTENCE ET l'attachabilité : un overlay non-attachable fait
#    rester api/caddy en "Created" (Cannot attach : not manually attachable).
# --------------------------------------------------------------------------- #
if $DOCKER network inspect boz_system >/dev/null 2>&1; then
  ATTACHABLE="$($DOCKER network inspect boz_system --format '{{.Attachable}}' 2>/dev/null || echo false)"
  if [ "$ATTACHABLE" = "true" ]; then
    log "Réseau overlay boz_system déjà présent (attachable)."
  else
    warn "boz_system présent mais NON-attachable — suppression puis recréation..."
    if ! $DOCKER network rm boz_system >/dev/null 2>&1; then
      warn "Conteneurs encore connectés : down avant suppression."
      $DOCKER compose down --remove-orphans >/dev/null 2>&1 || true
      $DOCKER network rm boz_system >/dev/null 2>&1 || die "Impossible de supprimer boz_system non-attachable."
    fi
    $DOCKER network create -d overlay --attachable boz_system >/dev/null
  fi
else
  log "Création de l'overlay attachable boz_system..."
  $DOCKER network create -d overlay --attachable boz_system >/dev/null
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
NODE_ENV=production
GHCR_OWNER=${GHCR_OWNER}
IMAGE_TAG=${IMAGE_TAG}
PUBLIC_HOST=${PUBLIC_HOST}
PUBLIC_URL=${PUBLIC_URL_DEFAULT}

POSTGRES_USER=ops
POSTGRES_PASSWORD=$(gen)
POSTGRES_DB=hullbay

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
$DOCKER compose pull
# up peut échouer une 1re fois (race overlay swarm) : pas de set -e ici, la
# garde de la section 7 relance up sur les services non démarrés.
$DOCKER compose up -d >/dev/null 2>&1 || true

# --------------------------------------------------------------------------- #
# 7. Garde-fou final : TOUS les services doivent être démarrés, sinon exit 1.
#    Empêche un install "réussi" en façade avec des conteneurs en Created/Exited.
#    Relance up sur les services non démarrés (race transitoire overlay swarm :
#    premier attach sur un overlay tout juste créé peut échouer "network not
#    found" puis réussir au retry).
# --------------------------------------------------------------------------- #
log "Vérification de l'état de tous les conteneurs..."
UP_ALL=0
for ATTEMPT in $(seq 1 8); do
  FAILED=""
  for SVC in postgres redis socket-proxy api web caddy; do
    ST="$($DOCKER compose ps --format '{{.Service}}\t{{.Status}}' 2>/dev/null | grep -E "^${SVC}[[:space:]]" | cut -f2 || true)"
    case "$ST" in
      Up*) : ;;
      *)   FAILED="${FAILED} ${SVC}[${ST:-absent}]" ;;
    esac
  done
  if [ -z "$FAILED" ]; then UP_ALL=1; break; fi
  if [ "$ATTEMPT" -lt 8 ]; then
    warn "Services pas encore démarrés :${FAILED} — relance up (tentative ${ATTEMPT}/8)..."
    $DOCKER compose up -d >/dev/null 2>&1 || true
    sleep 10
  fi
done

if [ "$UP_ALL" != "1" ]; then
  echo ""
  $DOCKER compose ps 2>/dev/null || true
  die "Services non démarrés :${FAILED}. Résolu puis relance install.sh."
fi
log "Tous les conteneurs sont démarrés (incl. postgres healthy)."

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
