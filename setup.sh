#!/bin/bash

# Esci immediatamente se un comando fallisce
set -e

echo "🚀 Inizio configurazione di Refurb-Labeler..."

# 1. Installa le dipendenze di Node.js
echo "📦 Installazione dei pacchetti npm..."
npm install --production

# 2. Copia il file di servizio in systemd (richiede sudo)
echo "⚙️ Configurazione del servizio systemd..."
sudo cp refurb-labeler.service /etc/systemd/system/refurb-labeler.service

# 3. Ricarica systemd per fargli leggere il nuovo servizio
echo "🔄 Ricaricamento di systemd..."
sudo systemctl daemon-reload

# 4. Abilita il servizio all'avvio e avvialo subito
echo "🔄 Abilitazione e avvio del servizio..."
sudo systemctl enable refurb-labeler.service
sudo systemctl restart refurb-labeler.service

echo "✅ Installazione completata con successo! Il servizio è attivo."
sudo systemctl status refurb-labeler.service
