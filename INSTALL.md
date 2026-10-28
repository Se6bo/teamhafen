# Teamhafen installieren (Anleitung für KI Agenten)

Diese Datei ist für einen KI Agenten geschrieben, der Teamhafen im Auftrag eines Menschen auf einem Linux Server installiert. Menschen können ihr genauso folgen.

## Grundregeln

- Ändere nichts an anderen Diensten auf dem Server, ohne vorher zu fragen. Bevor du eine bestehende Konfiguration (zum Beispiel ein Caddyfile oder eine nginx Datei) änderst, lege eine Sicherung mit Zeitstempel an.
- Schreib Schlüssel und Passwörter nicht in Dateien außerhalb von `.env` und nicht in Git.
- Melde Fehler ehrlich und mit der konkreten Meldung, statt sie zu umgehen.

## 1. Vorher klären

Frag den Menschen, falls er es nicht schon gesagt hat:

1. **Module.** Zur Auswahl:
   - `vault`: Passwort Tresor (Speicher Vaultwarden)
   - `docs`: Dokumentation
   - `office`: Word, Excel und PowerPoint im Browser (braucht `docs`, etwa 1 bis 2 GB RAM)
   - `sprints`: Jira Sprints (braucht Jira Cloud Adresse, E-Mail, API Token, Projektschlüssel, Board Nummer)
   - `ai`: MCP Server für die eigene KI (braucht `docs` oder `sprints`)

   Wer „nur den Tresor“ will, nimmt `vault`.
2. **Adresse**, unter der das Portal erreichbar sein soll, zum Beispiel `https://tresor.example.org`. Die Domain muss schon auf den Server zeigen. Zum reinen Ausprobieren geht `http://localhost:8080`.
3. **Webserver.** Läuft schon ein Webserver oder Reverse Proxy (Caddy, nginx, Traefik, Apache) auf den Ports 80 und 443? Das kannst du auch selbst prüfen (Schritt 2).
4. Optional: **Name** des Portals (Standard „Teamhafen“), **Installationsordner** (Standard `~/teamhafen`).

## 2. Voraussetzungen prüfen

```bash
docker --version
docker compose version   # muss v2.20 oder neuer sein
git --version
openssl version
ss -ltnp | grep -E ':(80|443|8080|9980) ' || true   # belegte Ports
```

Fehlt Docker, installiere es nach der offiziellen Anleitung für die Distribution (https://docs.docker.com/engine/install/) und frag vorher, ob du das darfst. Ist Port 8080 belegt, wähle mit `--port` einen freien Port. Mit `office` muss auch 9980 frei sein (sonst `COLLABORA_PORT=<frei>` in `.env` ergänzen).

## 3. Herunterladen

```bash
git clone https://github.com/Se6bo/teamhafen.git ~/teamhafen
cd ~/teamhafen
```

## 4. Installieren

Rufe `install.sh` ohne Rückfragen auf. Wähle die Variante nach Schritt 1:

**A) Es läuft schon ein Reverse Proxy** (oder nur lokal testen):

```bash
./install.sh --yes --modules <MODULE> --url <ADRESSE> --name "<NAME>" --port 8080
```

**B) Kein Webserver auf 80/443, Domain zeigt auf den Server:** eingebauten Caddy mit automatischem Zertifikat nutzen:

```bash
./install.sh --yes --modules <MODULE> --url <ADRESSE> --name "<NAME>" --https
```

Mit `sprints` zusätzlich: `--jira-url <URL> --jira-email <MAIL> --jira-token <TOKEN> --jira-project <KEY> --jira-board <NR>`.

Das Skript schreibt `.env` (mit neuen, zufälligen Schlüsseln), baut das Image, startet die Container und gibt am Ende **Adresse, Benutzername und das erste Passwort** aus. Merk dir das Passwort für die Rückmeldung; es steht nirgends sonst.

## 5. Reverse Proxy einrichten (nur Variante A mit eigener Domain)

Das Portal lauscht auf `127.0.0.1:<PORT>`. Ergänze beim vorhandenen Webserver die Domain. Vorher die Konfiguration mit Zeitstempel sichern, danach prüfen und neu laden.

Caddy ohne `office`:

```caddyfile
tresor.example.org {
	reverse_proxy 127.0.0.1:8080
}
```

Caddy mit `office`: siehe Abschnitt „Reverse Proxy“ in der README (Pfade `/browser/*`, `/hosting/discovery`, `/hosting/capabilities`, `/cool/*` an `127.0.0.1:9980`, Admin Pfade sperren).

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
# Block ergänzen, dann:
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

nginx: `proxy_pass http://127.0.0.1:8080;` mit `proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` und `client_max_body_size 60m;`. Mit `office` die Collabora Pfade an Port 9980 inklusive WebSocket Upgrade.

## 6. Prüfen

```bash
docker compose ps                                  # alle Dienste "running", app "healthy"
curl -s http://127.0.0.1:8080/api/health           # {"status":"ok","modules":[...]}
curl -sI <ADRESSE> | head -1                       # 200 über die öffentliche Adresse
docker compose logs app | tail -20                 # mit vault: "[Tresor] Vaultwarden bereit"
```

Wenn `modules` nicht der Auswahl entspricht oder der Tresor nicht bereit ist, lies die Logs und behebe die Ursache.

## 7. Rückmeldung an den Menschen

Sag kurz:

- Adresse des Portals
- Benutzername (Standard `admin`) und erstes Passwort, mit dem Hinweis, es nach der Anmeldung unter Einstellungen → Passwort ändern zu ersetzen
- welche Module laufen
- wo die Daten liegen (`~/teamhafen/data` und `~/teamhafen/.env`) und dass beides zusammen gesichert werden muss
- falls `vault`: Die Browser Erweiterung gibt es im Portal unter Einstellungen → Browser Erweiterung. Einen privaten Tresor für sich bekommt man mit `PRIVATE_VAULT_USERS=1` in `.env` und `docker compose up -d`.
- falls `ai`: Jeder holt sich unter Einstellungen → KI verbinden einen eigenen Prompt für seine KI.

## Später ändern

- Module ändern: `./install.sh --yes --modules <NEU> --url <ADRESSE>` erneut ausführen (Schlüssel und Daten bleiben).
- Update: `git pull && docker compose up -d --build`
- Deinstallieren: `docker compose down` (Daten bleiben in `data/`). Den Ordner erst nach Rückfrage löschen.
