# Teamhafen

Selbst gehostetes Teamportal, Baustein für Baustein: ein **Passwort Tresor**, der intern in **Vaultwarden** speichert, aber ohne Master Passwort mit ganz normalen Benutzerkonten funktioniert, dazu bei Bedarf **Dokumentation**, **Office im Browser**, **Jira Sprints** und ein **MCP Server**, über den jedes Teammitglied seine eigene KI anbindet.

Du nimmst nur, was du brauchst. Wer nur einen Teamtresor will, installiert nur den Tresor.

| Modul | Was es kann | Braucht |
|---|---|---|
| `vault` | Gemeinsamer Passwort Tresor mit Ordnern, TOTP (2FA Codes), Passwortverlauf, Generator, privatem Bereich für einzelne Personen und Browser Erweiterung. Gespeichert wird verschlüsselt in Vaultwarden. | Docker Dienst Vaultwarden (startet automatisch mit) |
| `docs` | Dokumentation im Explorer Layout: Ordner, Dokumente mit Editor und Versionsverlauf, Dateien (PDF, Bilder, Word …) per Drag and Drop | – |
| `office` | Word, Excel und PowerPoint direkt im Browser bearbeiten | `docs`, Collabora (startet automatisch mit, etwa 1 bis 2 GB RAM) |
| `sprints` | Sprint Board, Backlog, Aufgaben, Kommentare und Zeitbuchung für ein Jira Cloud Projekt | Jira Zugang (API Token) |
| `ai` | MCP Server: Jeder verbindet seine eigene KI (Claude, ChatGPT, Codex, Cursor …) mit Doku und Sprints, mit den eigenen Rechten. Der Tresor bleibt für die KI gesperrt. | `docs` oder `sprints` |

Immer dabei: Anmeldung mit Passwort oder Passkey, Benutzerverwaltung, globale Suche (`Strg+K`), helles und dunkles Design.

## Installation mit deinem KI Agenten

Kopiere diesen Prompt in Claude Code, Codex, OpenCode oder einen anderen Agenten, der auf deinem Server Befehle ausführen darf:

```text
Installiere mir Teamhafen (https://github.com/Se6bo/teamhafen) auf diesem Server.
Lies zuerst die Datei INSTALL.md im Repository und halte dich genau daran.
Frag mich vorher nur das, was dort unter "Vorher klären" steht: welche Module ich möchte
(zum Beispiel nur den Tresor), unter welcher Adresse das Portal erreichbar sein soll
und ob auf dem Server schon ein Webserver oder Reverse Proxy läuft.
Wenn du fertig bist, sag mir die Adresse, den Benutzernamen und das erste Passwort.
```

Der Agent klont das Repository, ruft `install.sh` mit den passenden Optionen auf, richtet bei Bedarf den Reverse Proxy ein und prüft, ob alles läuft.

## Installation von Hand

Voraussetzungen: Linux Server mit Docker und dem Compose Plugin (v2.20 oder neuer), `git`, `openssl`. Für HTTPS eine Domain, die auf den Server zeigt.

```bash
git clone https://github.com/Se6bo/teamhafen.git
cd teamhafen
./install.sh
```

Das Skript fragt nach Modulen, Adresse und Namen, erzeugt eigene Schlüssel, schreibt `.env`, baut das Image und startet alles. Am Ende stehen Adresse, Benutzername und erstes Passwort im Terminal.

Ohne Rückfragen geht es auch:

```bash
# nur der Tresor, hinter einem vorhandenen Reverse Proxy
./install.sh --yes --modules vault --url https://tresor.example.org

# alles, mit eingebautem Caddy für HTTPS (Ports 80 und 443 müssen frei sein)
./install.sh --yes --modules vault,docs,office,sprints,ai --url https://portal.example.org --https \
  --jira-url https://firma.atlassian.net --jira-email du@firma.de --jira-token … --jira-project PROJ --jira-board 1
```

Alle Optionen: `./install.sh --help`. Später Module ändern: `install.sh` einfach noch einmal mit anderen Modulen aufrufen. Schlüssel und Daten bleiben erhalten, die alte `.env` wird vorher gesichert.

## Reverse Proxy

Das Portal lauscht auf `127.0.0.1:8080` (änderbar mit `--port`). Läuft auf dem Server schon ein Webserver, leitest du die Domain dorthin weiter. Für Caddy:

```caddyfile
tresor.example.org {
	reverse_proxy 127.0.0.1:8080
}
```

Mit dem Modul `office` müssen zusätzlich einige Pfade an Collabora gehen, siehe [`docker/Caddyfile`](docker/Caddyfile):

```caddyfile
portal.example.org {
	@collabora_admin path /browser/dist/admin/* /cool/adminws* /cool/getMetrics*
	@collabora path /browser/* /hosting/discovery /hosting/capabilities /cool/*
	handle @collabora_admin {
		respond 403
	}
	handle @collabora {
		reverse_proxy 127.0.0.1:9980
	}
	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
```

Für nginx gilt dasselbe: `/browser/`, `/hosting/` und `/cool/` an Port 9980 (mit WebSocket Upgrade), alles andere an Port 8080.

Passkeys und die Zwischenablage brauchen HTTPS. Nur zum Ausprobieren auf dem eigenen Rechner reicht `http://localhost:8080`.

## So funktioniert der Tresor

```
Browser ──► Teamhafen (Node.js, Express, SQLite) ──► Vaultwarden (nur im internen Docker Netz)
             │  rechnet wie eine Bitwarden App:
             │  PBKDF2, HKDF, AES 256 CBC mit HMAC, RSA
             └─ SQLite: Benutzer, Rechte, Ordnerbaum, Verlauf (ohne Geheimnisse)
```

- Teamhafen ist selbst ein Bitwarden Client. Für den gemeinsamen Tresor und für jeden privaten Tresor gibt es ein eigenes Dienstkonto in Vaultwarden (`team@teamhafen.local`, `privat-<ID>@teamhafen.local`). Deren Master Passwörter erzeugt der Server zufällig und speichert sie mit `CRYPTO_KEY` verschlüsselt. Die Mitglieder melden sich nur am Portal an.
- Namen, Benutzernamen, Passwörter, TOTP Geheimnisse, Adressen und Notizen liegen verschlüsselt in Vaultwarden. In SQLite steht nur ein Verzeichnis ohne Geheimnisse.
- Vaultwarden ist von außen nicht erreichbar, hat keinen Internetzugang und nimmt neue Konten nur für die interne Domain an.
- Ehrlich gesagt: Ohne Master Passwort kennt der Server die Schlüssel. Wer den Server übernimmt, kommt an die Daten. Das ist der Preis dafür, dass niemand ein zweites Passwort braucht.
- **Privater Tresor:** Mit `PRIVATE_VAULT_USERS=1` (Benutzer IDs, mit Kommas) bekommt dieser Benutzer einen Bereich, den nur er sieht, auch Admins und die KI nicht. Konten mit privatem Tresor kann nur ihr Besitzer selbst ändern.
- **Browser Erweiterung:** Unter Einstellungen → Browser Erweiterung gibt es fertige ZIPs für Chrome/Edge und Firefox, schon auf die eigene Adresse eingestellt.

## Betrieb

| Aufgabe | Befehl |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f app` |
| Update | `git pull && docker compose up -d --build` |
| Stoppen | `docker compose down` |
| Notfallzugang zu Vaultwarden | `docker compose exec app node scripts/vaultwarden-zugang.mjs` |
| Tresor als Bitwarden JSON exportieren | `docker compose exec -T app node scripts/vaultwarden-zugang.mjs --export > export.json` (unverschlüsselt, danach löschen) |

**Sicherung:** Alle Daten liegen im Ordner `data/` (Portal Datenbank, Uploads, Vaultwarden). Dazu gehört die Datei `.env` mit den Schlüsseln, ohne sie lässt sich der Tresor nicht mehr öffnen. Für eine konsistente Sicherung kurz stoppen:

```bash
docker compose stop && tar czf teamhafen-$(date +%F).tar.gz data .env && docker compose start
```

## Einstellungen (`.env`)

| Variable | Bedeutung |
|---|---|
| `APP_NAME` | Name in der Oberfläche, Standard `Teamhafen` |
| `MODULES` | aktive Module, z. B. `vault` oder `vault,docs,office,sprints,ai` |
| `COMPOSE_PROFILES` | Zusatzdienste: `vault` (Vaultwarden), `office` (Collabora), `https` (Caddy) |
| `PUBLIC_URL`, `PUBLIC_HOST` | öffentliche Adresse und Hostname |
| `APP_PORT` | lokaler Port für den Reverse Proxy, Standard `8080` |
| `JWT_SECRET`, `CRYPTO_KEY` | Schlüssel der Installation (je 64 Hex Zeichen). Nie ändern. |
| `ADMIN_USERNAME` | Name des ersten Kontos |
| `PRIVATE_VAULT_USERS` | Benutzer IDs mit privatem Tresor |
| `VW_ACCOUNT_DOMAIN` | Domain der internen Vaultwarden Konten, Standard `teamhafen.local` |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_BOARD_ID` | Zugang für `sprints` |
| `JIRA_SYNC_INTERVAL_SECONDS` | Abgleich mit Jira, Standard 30 |
| `BOT_TOKEN` | schaltet die Bot Schnittstelle `/api/bot/docs` frei (mindestens 16 Zeichen, Anmeldung mit `Authorization: Bearer …`), sonst ist sie aus |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_ORIGIN` | nur setzen, wenn Passkeys hinter dem Proxy nicht klappen |

## Sicherheit

- Öffentliche Registrierung ist aus. Neue Konten legt ein Admin unter Einstellungen → Benutzer verwalten an.
- Anmeldepasswörter mit bcrypt, Anmeldung per JWT (7 Tage), Abmeldung nach 15 Minuten ohne Aktivität, Passkeys (WebAuthn), Rate Limiting, Security Header (Helmet), nur parametrisierte SQL Abfragen.
- Ohne eigenes `JWT_SECRET` und `CRYPTO_KEY` startet der Server nicht.
- KI Schlüssel werden nur als SHA 256 Hash gespeichert, sind widerrufbar und erreichen nur Doku und Sprints, nie Tresor, Benutzer oder Suche. Löschen geht über die KI nicht.
- Die globale Suche liefert aus dem Tresor nur Name, Benutzername und Adresse, nie Passwörter.
- Hochgeladene Dateien liegen unter zufälligen, nicht erratbaren Adressen, aber ohne zusätzliche Anmeldung. Links also nicht nach außen geben.

## Entwicklung

```bash
npm install
cd server
JWT_SECRET=$(openssl rand -hex 32) CRYPTO_KEY=$(openssl rand -hex 32) MODULES=docs PORT=4001 DB_PATH=./dev.db npm run dev
```

Für den Tresor eine Vaultwarden Instanz starten und `VW_URL` darauf zeigen lassen, zum Beispiel:

```bash
docker run -d --name vw-dev -p 127.0.0.1:8099:80 -e SIGNUPS_ALLOWED=false -e SIGNUPS_VERIFY=false \
  -e SIGNUPS_DOMAINS_WHITELIST=teamhafen.local vaultwarden/server:1.37.3
```

Aufbau: Server in `server/server` (Express, `routes/`, `vault/`, `mcp/`, `jira/`, `office/`), Oberfläche als statische Seiten in `web/` ohne Build Schritt, Browser Erweiterung in `extension/`, Module zentral in `server/server/config.mjs`.

## Bekannte Grenzen

- Oberfläche und Texte sind auf Deutsch.
- Jira: nur Jira Cloud. Jira kennt nur eine Ebene Unteraufgaben; tiefere Ebenen bildet Teamhafen über das Label `teil-von-<Schlüssel>` ab. Beschreibungen werden als einfacher Text bearbeitet.
- Collabora im Home Modus: höchstens 10 gleichzeitig geöffnete Dateien und 20 Verbindungen.
- Firefox behält eine selbst geladene Erweiterung nur bis zum Neustart, außer sie wird von Mozilla signiert.

## Lizenz

[MIT](LICENSE)
