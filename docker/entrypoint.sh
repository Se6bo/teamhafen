#!/bin/sh
# Browser Erweiterung mit Name und Adresse dieser Installation bauen, dann den Server starten
node /app/server/scripts/build-extension.mjs || echo "[Erweiterung] Konnte nicht gebaut werden, der Server startet trotzdem."
exec "$@"
