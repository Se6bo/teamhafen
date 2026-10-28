#!/usr/bin/env bash
# Teamhafen installieren oder neu konfigurieren.
#
# Ohne Angaben fragt das Skript alles ab. Für KI Agenten und Automatisierung geht es auch ohne Rückfragen:
#   ./install.sh --yes --modules vault --url https://tresor.example.org
#   ./install.sh --yes --modules vault,docs,office,sprints,ai --url https://portal.example.org --https
#
# Optionen
#   --modules LISTE   vault, docs, office, sprints, ai (mit Kommas). Standard: vault
#   --url ADRESSE     öffentliche Adresse mit https://, z. B. https://portal.example.org
#   --name NAME       Name des Portals in der Oberfläche. Standard: Teamhafen
#   --https           eingebauten Caddy starten (holt das Zertifikat, braucht freie Ports 80 und 443)
#   --port PORT       Port auf 127.0.0.1 für einen eigenen Reverse Proxy. Standard: 8080
#   --admin NAME      Benutzername des ersten Kontos. Standard: admin
#   --jira-url, --jira-email, --jira-token, --jira-project, --jira-board   Zugang für das Modul sprints
#   --no-start        nur .env schreiben, nichts starten
#   --yes             keine Rückfragen
set -euo pipefail
cd "$(dirname "$0")"

MODULES="" URL="" NAME="" HTTPS="" PORT="" ADMIN="" START=1 YES=0
JIRA_BASE_URL="" JIRA_EMAIL="" JIRA_API_TOKEN="" JIRA_PROJECT_KEY="" JIRA_BOARD_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --modules) MODULES="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --https) HTTPS=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --jira-url) JIRA_BASE_URL="$2"; shift 2 ;;
    --jira-email) JIRA_EMAIL="$2"; shift 2 ;;
    --jira-token) JIRA_API_TOKEN="$2"; shift 2 ;;
    --jira-project) JIRA_PROJECT_KEY="$2"; shift 2 ;;
    --jira-board) JIRA_BOARD_ID="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (Hilfe mit --help)" >&2; exit 1 ;;
  esac
done

ask() { # ask VAR "Frage" "Standard"
  local var="$1" question="$2" default="${3:-}" answer
  if [ -n "${!var}" ] || [ "$YES" = 1 ]; then
    if [ -z "${!var}" ]; then printf -v "$var" '%s' "$default"; fi
    return 0
  fi
  read -r -p "$question${default:+ [$default]}: " answer
  printf -v "$var" '%s' "${answer:-$default}"
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "Fehlt: $1. Bitte zuerst installieren." >&2; exit 1; }; }
need docker
docker compose version >/dev/null 2>&1 || { echo "Fehlt: docker compose (Plugin v2)." >&2; exit 1; }
need openssl

echo "Teamhafen einrichten"
echo "Module: vault (Tresor), docs (Dokumentation), office (Word/Excel im Browser, braucht docs),"
echo "        sprints (Jira), ai (MCP Server für die eigene KI, braucht docs oder sprints)"
ask MODULES "Welche Module (mit Kommas)" "vault"
ask URL "Öffentliche Adresse (mit https://)" "http://localhost:8080"
ask NAME "Name des Portals" "Teamhafen"
ask ADMIN "Benutzername des ersten Kontos" "admin"
ask PORT "Lokaler Port für den Reverse Proxy" "8080"
if [ -z "$HTTPS" ] && [ "$YES" = 0 ]; then
  read -r -p "Eingebauten Caddy für HTTPS starten? (nur ohne anderen Webserver auf 80/443) [j/N]: " a
  case "$a" in j|J|ja|y|Y) HTTPS=1 ;; esac
fi

MODULES="$(echo "$MODULES" | tr -d ' ' | tr 'A-Z' 'a-z')"
has() { case ",$MODULES," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
for m in $(echo "$MODULES" | tr ',' ' '); do
  case "$m" in vault|docs|office|sprints|ai) ;; *) echo "Unbekanntes Modul: $m" >&2; exit 1 ;; esac
done
if has office && ! has docs; then echo "office braucht docs." >&2; exit 1; fi
if has ai && ! has docs && ! has sprints; then echo "ai braucht docs oder sprints." >&2; exit 1; fi

if has sprints; then
  ask JIRA_BASE_URL "Jira Adresse (z. B. https://firma.atlassian.net)" ""
  ask JIRA_EMAIL "Jira E-Mail" ""
  ask JIRA_API_TOKEN "Jira API Token" ""
  ask JIRA_PROJECT_KEY "Jira Projektschlüssel (z. B. PROJ)" ""
  ask JIRA_BOARD_ID "Jira Board Nummer" ""
fi

URL="${URL%/}"
HOST="$(echo "$URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"

PROFILES=""
if has vault; then PROFILES="vault"; fi
if has office; then PROFILES="${PROFILES:+$PROFILES,}office"; fi
if [ -n "$HTTPS" ]; then PROFILES="${PROFILES:+$PROFILES,}https"; fi

# Vorhandene Schlüssel behalten: neue würden alle Anmeldungen und den Tresor Zugang ungültig machen
keep() { [ -f .env ] && grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
JWT_SECRET="$(keep JWT_SECRET)"; [ -n "$JWT_SECRET" ] || JWT_SECRET="$(openssl rand -hex 32)"
CRYPTO_KEY="$(keep CRYPTO_KEY)"; [ -n "$CRYPTO_KEY" ] || CRYPTO_KEY="$(openssl rand -hex 32)"
VW_ACCOUNT_DOMAIN="$(keep VW_ACCOUNT_DOMAIN)"; [ -n "$VW_ACCOUNT_DOMAIN" ] || VW_ACCOUNT_DOMAIN="teamhafen.local"
PRIVATE_VAULT_USERS="$(keep PRIVATE_VAULT_USERS)"
# Das erste Passwort landet nicht in .env, es wird nur beim ersten Start übergeben
FIRST_RUN=0
ADMIN_PASSWORD=""
if [ ! -f data/app/portal.db ]; then
  FIRST_RUN=1
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
fi

if [ -f .env ]; then
  cp -a .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
fi

umask 077
cat > .env <<ENV
# Erzeugt von install.sh am $(date '+%d.%m.%Y %H:%M'). Geheim halten, nicht ins Git.
APP_NAME=$NAME
MODULES=$MODULES
COMPOSE_PROFILES=$PROFILES
PUBLIC_URL=$URL
PUBLIC_HOST=$HOST
APP_PORT=$PORT

# Schlüssel dieser Installation. Nie ändern, sonst sind Anmeldungen und Tresor Zugang weg.
JWT_SECRET=$JWT_SECRET
CRYPTO_KEY=$CRYPTO_KEY

# Erstes Konto (wird nur beim allerersten Start angelegt)
ADMIN_USERNAME=$ADMIN

# Tresor: E-Mail Domain der internen Vaultwarden Konten, privater Tresor für diese Benutzer IDs (z. B. 1)
VW_ACCOUNT_DOMAIN=$VW_ACCOUNT_DOMAIN
PRIVATE_VAULT_USERS=$PRIVATE_VAULT_USERS

# Sprints (Jira)
JIRA_BASE_URL=$JIRA_BASE_URL
JIRA_EMAIL=$JIRA_EMAIL
JIRA_API_TOKEN=$JIRA_API_TOKEN
JIRA_PROJECT_KEY=$JIRA_PROJECT_KEY
JIRA_BOARD_ID=$JIRA_BOARD_ID
ENV
echo ".env geschrieben (Module: $MODULES, Dienste: ${PROFILES:-nur Portal})."

mkdir -p data/app data/vaultwarden data/caddy

if [ "$START" = 0 ]; then
  echo "Starten später mit: docker compose up -d --build"
  exit 0
fi

ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose up -d --build --remove-orphans

echo -n "Warte auf das Portal "
for _ in $(seq 1 60); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:80/api/health >/dev/null 2>&1; then echo " bereit."; break; fi
  echo -n "."; sleep 2
done

echo
echo "Fertig. Adresse: $URL"
if [ "$FIRST_RUN" = 1 ]; then
  echo "Anmeldung: $ADMIN / $ADMIN_PASSWORD  (bitte gleich unter Einstellungen → Passwort ändern)"
fi
if [ -z "$HTTPS" ]; then
  echo "Das Portal lauscht auf 127.0.0.1:$PORT. Richte deinen Reverse Proxy darauf ein (siehe README, Abschnitt Reverse Proxy)."
fi
