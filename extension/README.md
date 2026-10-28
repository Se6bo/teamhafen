# Tresor Auto-Fill (Browser Erweiterung)

Diese Erweiterung liest deine Zugangsdaten aus dem Teamhafen Tresor und füllt sie auf
Login-Formularen der aktuell geöffneten Webseite automatisch aus. **Wichtig:** Sie tippt
**nicht systemweit** wie ein Desktop-Programm (z. B. KeePass) — sie kann Formulare ausschließlich
im aktiven Browser-Tab desselben Browsers befüllen, in dem sie installiert ist.

## Installation

Die heruntergeladene Datei ist eine ZIP-Archiv und landet je nach Browser-Einstellung meist
automatisch im Ordner „Downloads" (Linux/Windows/Mac). Bevor ein Browser die Erweiterung laden
kann, muss dieses Archiv erst entpackt werden: im Dateimanager mit der rechten Maustaste auf die
ZIP-Datei klicken und „Hier entpacken" bzw. „Extrahieren" wählen (Bezeichnung je nach Dateimanager
leicht unterschiedlich). Danach liegt ein normaler Ordner mit Dateien wie `background.js`,
`popup.html`, `manifest.json` usw. daneben — diesen entpackten Ordner brauchst du in den
folgenden Schritten, nicht die ZIP-Datei selbst.

### Chrome / Edge

1. ZIP-Datei vollständig entpacken.
2. Die ZIP aus dem Portal enthält schon eine fertige `manifest.json` mit der Adresse deines Portals.
3. Adresse `chrome://extensions` (bzw. `edge://extensions`) in die Adressleiste eingeben und mit
   Enter bestätigen.
4. Oben rechts auf der Seite den Schalter „Entwicklermodus" aktivieren.
5. Auf „Entpackte Erweiterung laden" klicken und den zuvor entpackten Ordner auswählen.
   Nicht die ZIP-Datei auswählen.
6. Direkt nach dem Laden erscheint die Erweiterungskarte in der Liste, teils mit einer gelb/orange
   hinterlegten Warnung. Das ist bei manuell geladenen, entpackten Erweiterungen normal.
7. Damit das Symbol der Erweiterung sichtbar in der Symbolleiste neben der Adressleiste erscheint,
   auf das Puzzleteil-Symbol klicken und die Erweiterung anpinnen.
8. Die Erweiterung bleibt als „Entpackte Erweiterung" installiert, solange der entpackte Ordner am
   selben Speicherort liegen bleibt. Beim Browser-Neustart bleibt sie erhalten.

### Firefox

Für eine **dauerhafte** Installation im normalen Firefox ist eine Signatur durch Mozilla nötig:
kostenlosen Account auf [addons.mozilla.org](https://addons.mozilla.org) anlegen und die
Erweiterung dort als „unlisted" einreichen (wird signiert zurückgegeben, aber nicht öffentlich
gelistet). Das ist ein manueller Schritt, den nur du mit deinem eigenen Mozilla-Account
durchführen kannst.

Für **sofortiges Testen** ohne Signatur:

- Firefox Developer Edition oder Firefox Nightly verwenden (erlauben unsignierte Add-ons), oder
- in normalem Firefox unter `about:config` die Einstellung `xpinstall.signatures.required` auf
  `false` setzen (nur in einem Test-Profil, nicht im Hauptprofil empfohlen).

Danach in der Adressleiste `about:debugging#/runtime/this-firefox` öffnen, auf „Temporäres Add-on
laden…" klicken und im Dateiauswahl-Dialog gezielt die Datei `manifest.json` im entpackten Ordner anklicken —
Firefox erwartet hier eine einzelne Manifest-Datei, keinen Ordner. Die Erweiterung erscheint danach
sofort in der Liste „Vorübergehende Erweiterungen" und ist einsatzbereit. Wichtig: Dieses
„temporäre Add-on" verschwindet automatisch, sobald Firefox neu gestartet wird, und muss dann über
denselben Weg erneut geladen werden — das ist ein grundsätzlicher Unterschied zur „Entpackten
Erweiterung" in Chrome/Edge, die einen Neustart übersteht.


## Bedienung

- Klick auf das Erweiterungssymbol öffnet das Popup: dort anmelden (gleiche Zugangsdaten wie
  im Web-Tresor), passende Einträge für die aktuelle Seite werden oben angezeigt, darunter immer
  eine durchsuchbare Liste aller Einträge als Fallback.
- Tastenkombination **Strg+Umschalt+L** (Mac: Cmd+Umschalt+L) füllt die Zugangsdaten der aktuellen
  Seite direkt aus, wenn es genau einen passenden Eintrag gibt. Bei keinem oder mehreren Treffern
  öffnet sich stattdessen das Popup zur Auswahl. Änderbar über die browsereigene
  Shortcut-Verwaltung (Chrome: `chrome://extensions/shortcuts`).
- Die Tresor-Adresse ist im Popup unter „Tresor-Adresse" einstellbar (einklappbarer Bereich in der
  Login-Ansicht). Standard ist die öffentliche Produktions-URL des Tresors.

## Sicherheits- und Verhaltenshinweise

- **Kein automatisches Absenden** von Formularen — die Erweiterung füllt Felder aus und fokussiert
  höchstens einen eindeutigen Absende-Button, klickt ihn aber nie selbst.
- **Kein automatisches Ausfüllen von TOTP-Codes**, außer in Feldern mit
  `autocomplete="one-time-code"` — keine sonstige Heuristik für 2FA-Felder.
- Domain-Zuordnung erfolgt per exaktem Hostname-Vergleich (ohne `www.`-Präfix), **ohne**
  Subdomain-Toleranz.
- Zugriff auf eine Tresor-Adresse, die nicht die feste Standard-Adresse ist, muss der Nutzer per
  Klick im Popup ausdrücklich erlauben (`ext.permissions.request`) — kein automatischer
  Zugriff auf beliebige Domains.
- **Automatischer Sitzungsablauf nach 15 Minuten Inaktivität** (analog zur Web-Oberfläche): Wird
  die Erweiterung 15 Minuten lang nicht für einen Datenabruf oder ein Ausfüllen genutzt, verwirft
  sie den gespeicherten Anmelde-Token. Beim nächsten Öffnen erscheint dann erneut die
  Login-Ansicht, allerdings mit bereits vorausgefülltem Benutzernamen und Fokus direkt im
  Passwortfeld — es muss also nur das Passwort erneut eingetippt werden. Jede erfolgreiche Nutzung
  verlängert die Sitzung um weitere 15 Minuten.

## Bekannte Einschränkung: Zwischenablage nach „Code kopieren"

Das Kopieren eines TOTP-Codes versucht, die Zwischenablage nach 60 Sekunden automatisch zu leeren.
Das funktioniert nur, solange das Popup-Fenster in dieser Zeit geöffnet bleibt — Browser beenden
Popup-Dokumente aber üblicherweise sofort beim Schließen oder Fokuswechsel. Eine zuverlässige
Variante über einen Hintergrund-Alarm (`ext.alarms`) würde die zusätzliche Berechtigung `"alarms"`
im Manifest voraussetzen, die hier bewusst nicht deklariert ist. Das automatische Leeren ist daher
ein **Best-Effort ohne Garantie**, kein verlässlicher Sicherheitsmechanismus.
