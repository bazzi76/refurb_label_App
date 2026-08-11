# CONTEXT.md — refurb_label_App

## Progetto

**Gateway Refurb Label App** — applicazione web per la verifica, stampa etichette e gestione box di gateway refurb (Edge/Techbase). Permette di collaudare dispositivi, stampare etichette Zebra, fogli di collaudo A4, gestire l'uscita/rientro di box verso terzista e cliente finale.

## Stack e avvio

- **Runtime**: Node.js + Express 4.18
- **Database**: PostgreSQL (host 10.11.12.8:5432, db `device_db`, utente `tester`)
- **Stampanti**: Zebra ZPL via TCP RAW (10.2.0.6:9100), CUPS stampante A4 `CollaudioA4`
- **PDF**: Chromium headless per HTML→PDF
- **Porta**: 3344 (http://0.0.0.0:3344)
- **Servizio systemd**: `refurb-labeler.service` (avvio automatico, restart=always)

```bash
# Installazione
cd /home/giacomo/refurb_label_App
npm install --production
sudo bash setup.sh   # installa e avvia il servizio systemd

# Avvio manuale
node server.js

# Restart servizio
sudo systemctl restart refurb-labeler.service
```

## Struttura

```
refurb_label_App/
├── server.js              (1902 righe) — backend Express: API, ZPL, PDF, gestione box
├── package.json           — dipendenze: express, pg
├── refurb-labeler.service — unit systemd
├── setup.sh               — script installazione servizio
├── .gitignore             — (include backups/ e *.bak_*)
├── backups/               — dump DB di sicurezza (gitignored)
├── public/
│   ├── index.html         (920 righe)  — UI principale: verifica SN/FR + stampa etichetta/collaudo
│   ├── report.html        (602 righe)  — report ICCID con export CSV/TXT/XLS
│   ├── outbox.html        (956 righe)  — box management: crea/consulta/rientro/dashboard
│   ├── logo_web.png
│   └── vari *.old / *.bak_* — backup storici (gitignored)
├── RemoteScript/
│   ├── gateway_test_V1.6.sh (355 righe) — script collaudo originale (intatto)
│   └── gateway_test_V2.0.sh (377 righe) — script collaudo + campo FR
└── .git/
```

### Tabelle DB

| Tabella | Scopo | Campi chiave |
|---------|-------|---------------|
| `device_tests` | Record collaudo gateway | id, sn, ext_sn, iccid, esito_test, sgw_type, data, data_stampa, **fr** |
| `outbound_boxes` | Scatole per spedizione | id, box_serial (UNIQUE), tipo, stato, data_creazione, data_spedizione, ddt_uscita, **archived** |
| `outbound_box_items` | FR associati a ogni box | id, box_id (FK CASCADE), fr, stato, data_inserimento, data_rientro, **ddt_rientro** |
| `rientri` | Audit trail rientri FR | id, fr, data_rientro, box_rientro, note, outbound_item_id (FK SET NULL), **ddt_rientro** |

> **Stati box** (`outbound_boxes.stato`): `creato` → `spedito` → `completato` (quest'ultimo quando tutti gli FR sono rientrati).
> **Stati FR** (`outbound_box_items.stato`): `raccolto` → `spedito` → `rientrato`.

### Endpoint API (server.js)

| Endpoint | Metodo | Funzione |
|----------|--------|----------|
| `/api/verify` | POST | Verifica gateway per **ext_sn (8000XXXX) o FR (FRXXXXX)** |
| `/api/print` | POST | Stampa etichetta ZPL su Zebra (3 copie) |
| `/api/print-collaudo` | POST | Stampa foglio collaudo A4 via CUPS |
| `/api/pdf-collaudo/:ext_sn` | GET | Genera e scarica PDF collaudo |
| `/api/report` | POST | Bulk lookup ICCID |
| `/api/outbox/create` | POST | Crea/aggiorna box con FR (gestisce spostamento FR rientrati); blocca se box già spedita |
| `/api/outbox/next-serial` | GET | Suggerisce prossimo seriale box disponibile |
| `/api/outbox/print-label` | POST | Stampa etichetta box su Zebra (N copie) |
| `/api/outbox/dashboard` | GET | Panoramica spediti/rientrati/spediti cliente |
| `/api/outbox/:box_serial` | GET | Recupera FR di un box (include ddt_rientro per FR) |
| `/api/outbox/:box_serial/export/:format` | GET | Export CSV/TXT |
| `/api/outbox/:box_serial/pdf` | GET | Genera PDF distinta box |
| `/api/outbox/ship` | POST | Marca box come spedita (**DDT opzionale**) |
| `/api/outbox/return` | POST | Registra rientro FR (singoli o in box) + DDT rientro; box → `completato` se tutti FR rientrati |
| `/api/outbox/:box_serial/promote` | POST | Crea box `uscita_cliente` e sposta in blocco gli FR rientrati (da box `uscita_terzista`) |
| `/api/outbox/:box_serial/archive` | PATCH | Archivia/disarchivia box vuota (0 FR); le archiviate non appaiono nel dashboard |
| `/api/outbox/:box_serial` | DELETE | Elimina box (solo se `creato`) |
| `/api/outbox/:box_serial/items/:fr` | DELETE | Rimuove un singolo FR (solo se box `creato`) |
| `/api/outbox/:box_serial` | PATCH | Modifica tipo box (solo se `creato`) |
| `/api/outbox/:box_serial/ddt` | PATCH | Imposta/modifica DDT di uscita (qualsiasi stato) |
| `/api/outbox/:box_serial/items/:fr/ddt-rientro` | PATCH | Imposta/modifica DDT di rientro di un FR (FR deve essere `rientrato`) |

## Cosa è stato fatto

### Sessione del 2026-08-10 (campo FR + sistema box base)

- **Campo FR su device_tests e script bash**:
  - `ALTER TABLE device_tests ADD COLUMN fr VARCHAR(50)` (nullable)
  - Creato `RemoteScript/gateway_test_V2.0.sh` (da V1.6, +22 righe): prompt FR con validazione `^FR[0-9]{5}$`, opzionale (INVIO per vuoto), incluso in INSERT e riepilogo
- **Sistema gestione box (outbox)**: tabelle `outbound_boxes`, `outbound_box_items`, `rientri`; pagina `outbox.html` con 4 tab; 14 endpoint API iniziali; etichetta box Zebra; next-serial; max FR configurabile; controllo cross-box con spostamento FR rientrati; dashboard 3 categorie.

### Sessione del 2026-08-11 (modifica box + ristampa + DDT rientro + ricerca FR)

- **Modifica/eliminazione box non spedita** (in Consulta Box, solo se stato `creato`):
  - Rimozione singolo FR (pulsante ✕ per riga) → `DELETE /api/outbox/:box_serial/items/:fr`
  - Aggiunta FR a box esistente → riuso `/api/outbox/create` (ora blocca se box già spedita)
  - Modifica tipo box → `PATCH /api/outbox/:box_serial`
  - Eliminazione intera box → `DELETE /api/outbox/:box_serial` (CASCADE rimuove FR)
- **UX tab**: box cliccabile nel tab Stato (apre Consulta Box con auto-ricerca); autofocus e reset automatico al cambio tab su tutti i tab.
- **Ristampa etichetta in Consulta Box**: sezione "Ristampa etichetta box" con campo copie (1-50), visibile dopo ogni consultazione.
- **QR code etichetta box ingrandito**: magnification 6 → 10 (~17,8mm), testo spostato a x=245.
- **Stato box dopo rientro**: `/api/outbox/return` ora aggiorna `outbound_boxes.stato` a `completato` quando tutti gli FR di una box sono rientrati (risposta include `completed_boxes`). Prima la box restava `spedito`.
- **DDT di uscita opzionale e inseribile dopo**:
  - `/api/outbox/ship`: DDT ora opzionale (spedizione possibile senza DDT)
  - `PATCH /api/outbox/:box_serial/ddt`: inserisce/modifica il DDT su una box in qualsiasi stato
  - Frontend Consulta Box: label "(opzionale)" in spedizione; sezione "DDT di uscita" editabile per box già spedita/completata
- **DDT di rientro legato al singolo FR**:
  - `ALTER TABLE rientri ADD COLUMN ddt_rientro` (audit) + `ALTER TABLE outbound_box_items ADD COLUMN ddt_rientro` (valore corrente per display)
  - `/api/outbox/return` accetta `ddt_rientro` opzionale (un DDT per la batch di FR rientrati)
  - `PATCH /api/outbox/:box_serial/items/:fr/ddt-rientro`: imposta/modifica il DDT di rientro di un FR già rientrato (aggiorna item + ultimo record in `rientri`)
  - Frontend: campo "DDT di rientro (opzionale)" in tab Rientro; colonna "DDT rientro" in Consulta Box con pulsante ✎ per modificarlo
- **Ricerca per FR in Stampa**:
  - `/api/verify` accetta `{ext_sn}` oppure `{fr}`; risposta include sempre `fr`
  - `index.html`: secondo input "oppure codice FR" (FR+5 cifre, priorità su SN); riepilogo con riga FR (N/A se assente)
  - Auto-verifica da query param `?fr=` / `?sn=` all'apertura della pagina
- **FR in riepilogo e report**: riga FR nel riepilogo a schermo (index.html) e nel foglio collaudo A4 (`buildCollaudoHTML`, riga Dati dispositivo + footer), con `N/A` per record storici senza FR.
- **Link verifica da Box Management**:
  - Crea Box: chip cliccabili dei FR inseriti (preview live) → aprono pagina Stampa con auto-verifica
  - Consulta Box: codici FR nella tabella cliccabili → pagina Stampa
- **Promote a uscita_cliente (sposta FR in blocco)**:
  - `POST /api/outbox/:box_serial/promote`: da una box `uscita_terzista` con FR rientrati, crea una nuova box `uscita_cliente` e sposta in blocco tutti gli FR rientrati (seriale auto o fornito). La box terzista resta vuota come storico.
  - Frontend Consulta Box: sezione "Spedisci al cliente" per box uscita_terzista con FR rientrati. Il flusso manuale di creazione/scansione FR resta invariato.
- **Archiviazione box vuote**:
  - `outbound_boxes.archived` (BOOLEAN default false); `PATCH /api/outbox/:box_serial/archive` archivia/disarchivia solo box vuote (0 FR)
  - Dashboard esclude le box archiviate; lookup le trova comunque (badge ARCHIVIATA)
- **Bug fix**: regression in `submitVerify` (body fetch usava `ext_sn` rimossa invece di `payload` → mostrato come "ERRORE DI RETE"), corretto.

## Stato attuale

- ✅ Sistema box fully functional: creazione, modifica/eliminazione (se non spedita), spedizione con DDT opzionale, rientro con DDT per FR, spostamento FR, dashboard
- ✅ Workflow completo verificato: terzista → rientro → box `completato` (test end-to-end con API)
- ✅ Etichetta box Zebra con QR ingrandito + ristampa da Consulta Box
- ✅ DDT di uscita opzionale + inseribile/modificabile dopo la spedizione
- ✅ DDT di rientro per singolo FR (inseribile e modificabile)
- ✅ Ricerca verifica per SN o FR; FR in riepilogo e report (N/A per record storici)
- ✅ Link "verifica FR" da Crea Box (chip) e Consulta Box (tabella) → pagina Stampa
- ✅ Servizio systemd attivo e funzionante
- ✅ Tutte le modifiche committate e pushate su `origin/main`

## TODO / questioni aperte

- **FR "Non Riparabile"** (futura gestione): alcuni gateway non conviene ripararli e vanno rispediti al cliente con dicitura "Non Riparabile".
  - Non avranno un risultato di `gateway_test_V2.0.sh` (nessun collaudo in `device_tests`).
  - Probabilmente rientrano insieme a fine ciclo di lavorazione (lotti da 100 verso il terzista) o dopo un paio di lotti.
  - Serve tenerne traccia per rendicontare al cliente (stato/etichetta dedicata, flusso di uscita cliente marcato "Non Riparabile", eventuale report).
  - Da definire: come contrassegnarli (flag in `device_tests`/`outbound_box_items`? tipo box dedicato?), come gestirli nel rientro e nel dashboard, ed eventuale dicitura su etichetta/report.
- **Storico FR / SN** (uso interno/statistico): vista che, dato un FR o uno SN, ricostruisce il suo percorso (box terzista, spedizioni, rientri, DDT, date) aggregando `device_tests` + `outbound_box_items` + `rientri`. Da progettare.
- Test in produzione di `gateway_test_V2.0.sh` (script collaudo + campo FR)
- Flusso `uscita_cliente` da testare end-to-end in produzione
- Possibile necessità di filtro nel dashboard per tipo box o intervallo date
- Valutare se serve un report/export del dashboard (PDF/Excel)
- Valutare se il campo FR in `device_tests` deve essere NOT NULL in futuro
- Verifica etichetta box stampata su Zebra in produzione (dimensioni QR ingrandito)

## Gotchas

- **File statici**: modifiche a `public/*.html` non richiedono restart del servizio (Express serve la directory statica); modifiche a `server.js` richiedono `sudo systemctl restart refurb-labeler.service`
- **Cache browser**: dopo modifiche a HTML/JS, fare hard refresh (Ctrl+Shift+R) per evitare cache stale
- **Regex seriali**: il sistema accetta sia `RBOX-NNNN` (nuovo) che `RBOX-OUT-NNNN` (legacy) — regex `^RBOX-(OUT-)?\d+$`
- **Regex FR**: `^FR\d{5}$` (es. FR62676). Case-insensitive (normalizzato a uppercase).
- **Credenziali DB**: hardcoded in `server.js` (host, user, password) — non in file `.env`
- **Chromium**: richiesto installato sul server per generazione PDF (`chromium --headless`)
- **Zebra**: connessione TCP RAW su 10.2.0.6:9100, timeout 5 secondi
- **CUPS**: stampante A4 configurata come `CollaudioA4`
- **Cancellazione box**: `DELETE FROM outbound_boxes` cascade-deleta anche `outbound_box_items`, ma i record in `rientri` rimangono (FK con ON DELETE SET NULL) — per pulizia completa serve `DELETE FROM rientri` esplicito
- **Reset sequenze**: dopo DELETE totale, usare `SELECT setval('seq_name', 1, false)` per ripartire da 1
- **Script bash V2.0**: eseguito da WSL, richiede `sshpass` e `postgresql-client`; lo script si collega via SSH al gateway (utente `sgw`) e scrive nel DB remoto
- **DDT rientro vs uscita**: DDT di uscita è a livello di box (`outbound_boxes.ddt_uscita`); DDT di rientro è a livello di FR (`outbound_box_items.ddt_rientro` + audit in `rientri.ddt_rientro`) — perché una box può rientrare parzialmente/in tempi diversi.
- **Promote vs creazione manuale**: il promote sposta in blocco gli FR rientrati in una nuova box uscita_cliente; la creazione manuale (scan FR) resta disponibile per le spedizioni mirate con pochi pezzi.
- **Archiviazione**: si archiviano solo box vuote (0 FR); restano rintracciabili in Consulta Box (per seriale) ma spariscono dal tab Stato.
- **Backup DB**: dump di sicurezza in `refurb_label_App/backups/` (gitignored). Ripristino: `psql -f backups/<file>.sql`
