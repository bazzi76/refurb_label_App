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
├── server.js              (1588 righe) — backend Express: API, ZPL, PDF, gestione box
├── package.json           — dipendenze: express, pg
├── refurb-labeler.service — unit systemd
├── setup.sh               — script installazione servizio
├── .gitignore
├── public/
│   ├── index.html         (877 righe)  — UI principale: verifica seriale + stampa etichetta/collaudo
│   ├── report.html        (602 righe)  — report ICCID con export CSV/TXT/XLS
│   ├── outbox.html        (684 righe)  — box management: crea/consulta/rientro/dashboard
│   ├── logo_web.png
│   └── vari *.old         — backup storici (gitignored)
├── RemoteScript/
│   ├── gateway_test_V1.6.sh (355 righe) — script collaudo originale (intatto)
│   └── gateway_test_V2.0.sh (377 righe) — script collaudo + campo FR
└── .git/
```

### Tabelle DB

| Tabella | Scopo | Campi chiave |
|---------|-------|---------------|
| `device_tests` | Record collaudo gateway | id, sn, ext_sn, iccid, esito_test, sgw_type, data, data_stampa, **fr** |
| `outbound_boxes` | Scatole per spedizione | id, box_serial (UNIQUE), tipo, stato, data_creazione, data_spedizione, ddt_uscita |
| `outbound_box_items` | FR associati a ogni box | id, box_id (FK CASCADE), fr, stato, data_inserimento, data_rientro |
| `rientri` | Audit trail rientri FR | id, fr, data_rientro, box_rientro, outbound_item_id (FK SET NULL) |

### Endpoint API (server.js)

| Endpoint | Metodo | Funzione |
|----------|--------|----------|
| `/api/verify` | POST | Verifica seriale gateway nel DB |
| `/api/print` | POST | Stampa etichetta ZPL su Zebra (3 copie) |
| `/api/print-collaudo` | POST | Stampa foglio collaudo A4 via CUPS |
| `/api/pdf-collaudo/:ext_sn` | GET | Genera e scarica PDF collaudo |
| `/api/report` | POST | Bulk lookup ICCID |
| `/api/outbox/create` | POST | Crea/aggiorna box con FR (gestisce spostamento FR rientrati) |
| `/api/outbox/next-serial` | GET | Suggerisce prossimo seriale box disponibile |
| `/api/outbox/print-label` | POST | Stampa etichetta box su Zebra (N copie) |
| `/api/outbox/:box_serial` | GET | Recupera FR di un box |
| `/api/outbox/:box_serial/export/:format` | GET | Export CSV/TXT |
| `/api/outbox/:box_serial/pdf` | GET | Genera PDF distinta box |
| `/api/outbox/ship` | POST | Marca box come spedita (registra DDT) |
| `/api/outbox/return` | POST | Registra rientro FR (singoli o in box) |
| `/api/outbox/dashboard` | GET | Panoramica spediti/rientrati/spediti cliente |

## Cosa è stato fatto in questa sessione

### Sessione del 2026-08-10

- **Campo FR su device_tests e script bash**:
  - `ALTER TABLE device_tests ADD COLUMN fr VARCHAR(50)` (nullable)
  - Creato `RemoteScript/gateway_test_V2.0.sh` (da V1.6, +22 righe): prompt FR con validazione `^FR[0-9]{5}$`, opzionale (INVIO per vuoto), incluso in INSERT e riepilogo
- **Sistema gestione box (outbox)**:
  - Create tabelle `outbound_boxes`, `outbound_box_items`, `rientri` con indici e FK
  - 14 endpoint API in server.js (+856 righe) per creazione, consultazione, spedizione, rientro, dashboard
  - Creata pagina `public/outbox.html` (684 righe) con 4 tab: Crea Box, Consulta Box, Rientro, Stato
  - Aggiunti link di navigazione in `index.html` e `report.html` (topbar)
- **Etichetta box su Zebra**:
  - Funzione `buildBoxLabelZPL()`: etichetta 50,8×25,4mm con QR code (magnification 6) + testo leggibile su due righe
  - Endpoint `/api/outbox/print-label` con parametro `copies` (1-50)
  - Bottoni stampa + copie nel frontend dopo creazione box
- **Suggerimento seriale consecutivo**:
  - Endpoint `/api/outbox/next-serial`: query MAX sul DB, formato neutro `RBOX-NNNN`
  - Precompilazione automatica nel frontend, refresh dopo creazione
- **Max FR configurabile**:
  - Input nel frontend con default 24, contatore dinamico che si adatta
- **Controllo cross-box FR**:
  - Prima dell'inserimento, verifica che gli FR non siano già in altre box
  - **FR con stato `rientrato` → spostati** nella nuova box (box_id aggiornato, stato→raccolto, data_rientro cancellata)
  - FR con stato `spedito` o `raccolto` → bloccati con errore
  - Tabella `rientri` conserva audit trail storico
- **Tracciamento spedizione/rientro**:
  - `POST /api/outbox/ship`: marca box spedita, registra DDT, tutti FR → stato `spedito`
  - `POST /api/outbox/return`: registra rientro FR (singoli o in box), marca `rientrato`, warning se non spedito/già rientrato
  - Sezione spedizione visibile per qualsiasi box in stato `creato` (testo adattato al tipo)
- **Dashboard con categorie separate**:
  - 3 card: In Lavorazione (terzista), Rientrati (pronti), Spediti al Cliente
  - Query distinte per `box.tipo` + `item.stato`
- **Bug trovati e risolti**:
  - Route Express `/api/outbox/dashboard` catturata da `/:box_serial` → spostato prima delle route parametriche
  - Conteggio dashboard `in_lavorazione` negativo → corretta query SQL (separati per tipo box)
  - Endpoint lookup non restituiva campi nuovi (stato, tipo, DDT) → aggiornate SELECT
  - Messaggi di errore con vecchio formato `RBOX-OUT-NNNN` → aggiornati a `RBOX-NNNN`
- **Decisioni prese**:
  - Formato seriale neutro `RBOX-NNNN` (backward compatible con `RBOX-OUT-NNNN`)
  - Tipo box come campo separato (`uscita_terzista` / `rientro_terzista` / `uscita_cliente`)
  - Spostamento FR rientrati invece di blocco totale (permette reuse cross-fase)
  - DDT registrato a livello di box, non di singolo FR

## Stato attuale

- ✅ Sistema box fully functional: creazione, spedizione con DDT, rientro, spostamento FR, dashboard
- ✅ Workflow completo verificato: terzista → rientro → cliente (test end-to-end con API)
- ✅ Dashboard con 3 categorie separate e testato
- ✅ Etichetta box Zebra con QR code + testo, N copie configurabile
- ✅ Controllo cross-box con logica spostamento FR rientrati
- ✅ DB pulito, sequenze resettate
- ✅ **Test con inserimento reale: SUPERATO** (10/08/2026)
- ✅ Servizio systemd attivo e funzionante
- ⚠️ Alcuni dettagli da rivedere in sessione successiva (da definire)

## TODO / questioni aperte

- Rivedere dettagli emersi durante il test reale (da definire nella prossima sessione)
- Verifica etichetta box stampata su Zebra (dimensioni QR code)
- Possibile necessità di filtro nel dashboard per tipo box o intervallo date
- Flusso `uscita_cliente` da testare end-to-end in produzione
- Valutare se serve un report/export del dashboard (PDF/Excel)
- Valutare se il campo FR in `device_tests` deve essere NOT NULL in futuro
- Git: le modifiche non sono ancora committate

## Gotchas

- **SSH tunnel warning**: i comandi SSH mostrano "Tunnel device open failed / Could not request tunnel forwarding" — è un warning innocuno del client SSH, non influisce sull'esecuzione
- **File statici**: modifiche a `public/*.html` non richiedono restart del servizio (Express serve la directory statica); modifiche a `server.js` richiedono `sudo systemctl restart refurb-labeler.service`
- **Regex seriali**: il sistema accetta sia `RBOX-NNNN` (nuovo) che `RBOX-OUT-NNNN` (legacy) — regex `^RBOX-(OUT-)?\d+$`
- **Credenziali DB**: hardcoded in `server.js` (host, user, password) — non in file `.env`
- **Chromium**: richiesto installato sul server per generazione PDF (`chromium --headless`)
- **Zebra**: connessione TCP RAW su 10.2.0.6:9100, timeout 5 secondi
- **CUPS**: stampante A4 configurata come `CollaudioA4`
- **Cancellazione box**: `DELETE FROM outbound_boxes` cascade-deleta anche `outbound_box_items`, ma i record in `rientri` rimangono (FK con ON DELETE SET NULL) — per pulizia completa serve `DELETE FROM rientri` esplicito
- **Reset sequenze**: dopo DELETE totale, usare `SELECT setval('seq_name', 1, false)` per ripartire da 1
- **Script bash V2.0**: eseguito da WSL, richiede `sshpass` e `postgresql-client`; lo script si collega via SSH al gateway (utente `sgw`) e scrive nel DB remoto
