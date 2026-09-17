# CONTEXT.md — refurb_label_App

## Progetto

**Gateway Refurb Label App** — applicazione web per la verifica, stampa etichette e gestione box di gateway refurb (Edge/Techbase). Permette di collaudare dispositivi, stampare etichette Zebra, fogli di collaudo A4, gestire l'uscita/rientro di box verso terzista e cliente finale.

## Stack e avvio

- **Runtime**: Node.js + Express 4.18
- **Database**: PostgreSQL (host 10.11.12.8:5432, db `device_db`, utente `tester`)
- **Stampanti**: Zebra ZPL via TCP RAW (10.2.0.6:9100), CUPS stampante A4 `CollaudioA4`
- **PDF**: Chromium headless per HTML→PDF
- **Porta**: 3344 (**https**://0.0.0.0:3344, certificato self-signed)
- **TLS**: certificato self-signed in `certs/` (valido 10 anni, SAN `IP:10.11.12.8`)
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
├── server.js              — backend Express: API, ZPL, PDF, gestione box, HTTPS
├── package.json           — dipendenze: express, pg
├── refurb-labeler.service — unit systemd
├── setup.sh               — script installazione servizio
├── .gitignore             — (include backups/ e *.bak_*)
├── certs/                 — certificato TLS self-signed (key.pem, cert.pem; gitignored)
├── backups/               — dump DB di sicurezza (gitignored)
├── public/
│   ├── index.html         (920 righe)  — UI principale: verifica SN/FR + stampa etichetta/collaudo
│   ├── report.html        (602 righe)  — report ICCID con export CSV/TXT/XLS
│   ├── outbox.html        (956 righe)  — box management: crea/consulta/rientro/dashboard/deposito
│   ├── fr-label.html      (160 righe)  — terminale stampa etichetta FR (QR+codice)
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

> **Stati box** (`outbound_boxes.stato`): `creato` → `spedito` → `in_deposito` (quest'ultimo quando tutti gli FR sono rientrati dal terzista; la box è ora "in magazzino" pronta per la fase cliente). Una box `in_deposito` può essere trasformata in `uscita_cliente` (`creato` → `spedito`). `completato` è deprecato (non più usato per le terzista; le box storiche sono state migrate a `in_deposito`).
> **Stati FR** (`outbound_box_items.stato`): `raccolto` → `spedito` → `rientrato`.

### Endpoint API (server.js)

| Endpoint | Metodo | Funzione |
|----------|--------|----------|
| `/api/verify` | POST | Verifica gateway per **ext_sn (8000XXXX) o FR (FRXXXXX)**; restituisce anche `box` (assegnazione FR o null = deposito) |
| `/api/print` | POST | Stampa etichetta ZPL su Zebra (3 copie) |
| `/api/print-fr` | POST | Stampa N etichette FR (QR del codice FR + testo); nessun DB |
| `/api/print-collaudo` | POST | Stampa foglio collaudo A4 via CUPS |
| `/api/pdf-collaudo/:ext_sn` | GET | Genera e scarica PDF collaudo (inline, HTTPS) |
| `/api/report` | POST | Bulk lookup ICCID |
| `/api/outbox/create` | POST | Crea/aggiorna box con FR (gestisce spostamento FR rientrati); blocca se box già spedita |
| `/api/outbox/next-serial` | GET | Suggerisce prossimo seriale box disponibile |
| `/api/outbox/print-label` | POST | Stampa etichetta box su Zebra (N copie) |
| `/api/outbox/dashboard` | GET | Panoramica spediti/rientrati/spediti cliente |
| `/api/outbox/:box_serial` | GET | Recupera FR di un box (include ddt_rientro per FR) |
| `/api/outbox/:box_serial/export/:format` | GET | Export CSV/TXT |
| `/api/outbox/:box_serial/pdf` | GET | Genera PDF distinta box (inline, HTTPS, paginato 20/pag, data spedizione) |
| `/api/outbox/ship` | POST | Marca box come spedita (**DDT opzionale**) |
| `/api/outbox/return` | POST | Registra rientro FR (singoli o in box) + DDT rientro; box → `completato` se tutti FR rientrati |
| `/api/outbox/:box_serial/promote` | POST | Crea box `uscita_cliente` e sposta in blocco gli FR rientrati (da box `uscita_terzista`) |
| `/api/outbox/:box_serial/archive` | PATCH | Archivia/disarchivia box vuota (0 FR); le archiviate non appaiono nel dashboard |
| `/api/outbox/:box_serial` | DELETE | Elimina box (solo se `creato`) |
| `/api/outbox/:box_serial/items/:fr` | DELETE | Rimuove un singolo FR (solo se box `creato`) |
| `/api/outbox/:box_serial` | PATCH | Modifica tipo box (solo se `creato`) |
| `/api/outbox/:box_serial/ddt` | PATCH | Imposta/modifica DDT di uscita (qualsiasi stato) |
| `/api/outbox/:box_serial/items/:fr/ddt-rientro` | PATCH | Imposta/modifica DDT di rientro di un FR (FR deve essere `rientrato`) |
| `/api/deposito` | GET | Lista FR in deposito (in `device_tests` con fr, non assegnati ad alcuna box) |
| `/api/outbox/assignable-boxes` | GET | Box `creato` (non archiviate) con capienza (count < 24) |
| `/api/outbox/assign` | POST | Assegna/sposta un FR in una box creato con capienza (deposito→box o box→box); blocca se `spedito` |
| `/api/outbox/assign-new` | POST | Crea nuova box (next serial, tipo) e ci assegna/sposta l'FR |
| `/api/outbox/create-empty` | POST | Crea una box vuota (next serial, tipo) |

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
- **Stato box dopo rientro**: `/api/outbox/return` aggiorna `outbound_boxes.stato` a `in_deposito` quando tutti gli FR di una box sono rientrati (risposta include `completed_boxes`). Lo stesso per `/api/outbox/return-box` (rientro box intera). Prima la box andava a `completato` (ora deprecato).
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
- **Stampa etichetta FR (pagina dedicata)**:
  - Nuova pagina `/fr-label.html` (integrazione di zebra-print-app): input FR (5 cifre o FR+5), copie default 2, autofocus, stampa su Zebra (QR del codice FR + testo, ZPL con `~SD25`/`^PR2`/`^PQ`).
  - `POST /api/print-fr` valida/formatta l'FR e stampa N copie. **Nessun inserimento DB**: l'FR viene registrato in `device_tests` al momento del collaudo (`gateway_test_V2.0.sh`).
  - Link "Etichetta FR" in topbar di Stampa, Box e Report.

- **Promote a uscita_cliente (sposta FR in blocco)**:
  - `POST /api/outbox/:box_serial/promote`: da una box `uscita_terzista` con FR rientrati, crea una nuova box `uscita_cliente` e sposta in blocco tutti gli FR rientrati (seriale auto o fornito). La box terzista resta vuota come storico.
  - Frontend Consulta Box: sezione "Spedisci al cliente" per box uscita_terzista con FR rientrati. Il flusso manuale di creazione/scansione FR resta invariato.
- **Archiviazione box vuote**:
  - `outbound_boxes.archived` (BOOLEAN default false); `PATCH /api/outbox/:box_serial/archive` archivia/disarchivia solo box vuote (0 FR)
  - Dashboard esclude le box archiviate; lookup le trova comunque (badge ARCHIVIATA)
- **FR fuori scatola (deposito) + assegnazione**:
  - Un FR è "in deposito" se è in `device_tests` (con fr) ma non ha riga in `outbound_box_items` (es. dopo cancellazione box). Endpoint `/api/deposito` li elenca.
  - `/api/verify` restituisce `box` (assegnazione corrente o null).
  - `POST /api/outbox/assign` (FR → box creato con capienza), `POST /api/outbox/assign-new` (crea box + assegna), `POST /api/outbox/create-empty` (box vuota).
  - index.html Verifica & Stampa: pannello "Gestione box" con stato (in box / in deposito), dropdown box con capienza + Assegna, oppure Crea nuova box + Crea e assegna.
  - outbox.html: nuovo tab **Deposito** con lista FR fuori scatola, box destinazione + Assegna per riga, Crea box vuota.
- **Bug fix**: regression in `submitVerify` (body fetch usava `ext_sn` rimossa invece di `payload` → mostrato come "ERRORE DI RETE"), corretto.

### Sessione del 2026-08-24 (PDF distinta: data spedizione, paginazione, HTTPS)

- **Data spedizione nel PDF distinta box**: l'endpoint `/api/outbox/:box_serial/pdf` estrae già `data_spedizione` dalla query ma non la mostrava. Aggiunta riga "Data spedizione" nell'info-box del PDF, visibile solo se la box è stata effettivamente spedita (`data_spedizione` non nulla).
- **Paginazione PDF a 20 elementi per pagina**: la tabella FR era un singolo blocco; con molte righe il footer `position: fixed` si sovrapponeva al contenuto. Implementata paginazione: i FR vengono suddivisi in blocchi da 20, ognuno in un `<div class="page-section">` con `page-break-after: always` tra le pagine. L'intestazione della tabella si ripete su ogni pagina; la numerazione FR è continua across le pagine. CSS: `.page-break { page-break-after: always; }` + `.page-section { page-break-inside: avoid; }`.
- **Rimozione footer**: il footer fisso ("Gruppo Sim Tel — Sistema Refurb Gateway") è stato rimosso del tutto dal PDF (CSS + HTML). Il padding inferiore del body è stato ripristinato a 16mm (non serve più spazio per il footer).
- **HTTPS con certificato self-signed**: Chrome bloccava i download PDF da HTTP come "download pericoloso". Prima tentato `Content-Disposition: inline` + `Content-Length` (non ha risolto: Chrome continuava a bloccare su HTTP). Poi implementato HTTPS:
  - Generato certificato self-signed con `openssl` in `certs/` (`key.pem` + `cert.pem`, valido 10 anni, SAN `IP:10.11.12.8`).
  - `server.js`: aggiunto `require('https')`, avvio cambiato da `app.listen()` a `https.createServer({key, cert}, app).listen(3344, '0.0.0.0')`.
  - I certificati sono letti da `path.join(__dirname, 'certs', 'key.pem')` e `cert.pem`.
  - Primo accesso: Chrome mostra "La connessione non è privata" → Avanzate → Procedi. Da quel momento l'eccezione è ricordata e i download non sono più bloccati.
  - **Backup**: `server.js.bak_20260824` (originale pre-modifiche).
- **Content-Disposition inline + Content-Length**: entrambi gli endpoint PDF (`/api/pdf-collaudo/:ext_sn` e `/api/outbox/:box_serial/pdf`) ora usano `Content-Disposition: inline` (invece di `attachment`) + `Content-Length` (da `fs.statSync`). Con HTTPS questo elimina l'avviso di download pericoloso.


### Sessione del 2026-08-25 (accesso DB da IP esterno per colleghi)

- **Problema**: i colleghi in remoto (IP pubblico fisso `95.230.187.122`) non riuscivano a collegarsi a PostgreSQL; il firewall inoltra correttamente a `10.11.12.8`, ma PostgreSQL rifiutava l'autenticazione. Log: `FATALE: nessuna voce in pg_hba.conf per l'host "95.230.187.122", utente "tester", database "device_db"`.
- **Diagnosi**: DB sano e raggiungibile (PostgreSQL 17 attivo, `listen_addresses = '*'`, login `tester@device_db` OK in locale). `pg_hba.conf` ammetteva solo `10.11.12.0/24`, `10.2.0.0/20`, `172.16.0.0/24`; l'IP esterno non era autorizzato.
- **Fix**: aggiunta riga in `/etc/postgresql/17/main/pg_hba.conf` (dopo la regola `172.16.0.0/24`):
  `host    all    all    95.230.187.122/32    scram-sha-256` + `sudo systemctl reload postgresql` (no downtime).
- **Backup pg_hba**: `/etc/postgresql/17/main/pg_hba.conf.bak_20260825_120801`.
- **Verifica**: regola caricata (linea 136 di `pg_hba_file_rules`); login locale `tester` ancora OK (nessuna regressione); i colleghi confermano accesso funzionante.
- **Nota**: nessun record storico di connessione riuscita da `95.230.187.122` nei log (rotazione fino al 2026-06-15). Il "prima delle ferie funzionava" si riferiva probabilmente a un accesso diverso (rete interna / VPN ZeroTier / altro IP pubblico). In futuro, un cambio di IP pubblico dei colleghi richiederà una nuova riga `pg_hba`, oppure conviene instradarli via ZeroTier (subnet già autorizzata).

### Sessione del 2026-08-29 (rientro box intera + deposito box rientrate + trasformazione in uscita_cliente)

- **Concetto**: il terzista rimette gli FR lavorati nella **stessa scatola d'origine**, così l'operatore può far **rientrare la box completa** in un'unica operazione (non più solo FR-per-FR). Le box rientrate diventano **"in deposito"** su cui riorganizzare gli FR (spostare, sciogliere, riempire fino a 24) prima di spedire al cliente. Mantenuto anche il rientro FR-per-FR per i casi parziali.
- **Nuovo stato box `in_deposito`** (sostituisce `completato` come stato "vivo" delle terzista rientrate). Ciclo: `creato` → `spedito` → `in_deposito` → (trasformazione) → `uscita_cliente` `creato` → `spedito`. `completato` non più usato per le terzista. Migrazione: RBOX-0002 e RBOX-0009 da `completato` a `in_deposito`.
- **Nuova tabella `box_history`** (id, box_id FK CASCADE, evento, tipo_old, stato_old, tipo_new, stato_new, esito, data, note): log delle trasformazioni della box, per ricostruirne il percorso (nascita terzista → spedizione → rientro → trasformazione cliente). Endpoint `GET /api/outbox/:box_serial/history` + campo `history` in `GET /api/outbox/:box_serial`.
- **Significato esito NULL dopo rientro** = gateway non riparato dal terzista, torna a noi per tentativo di laboratorio (NON è `non_riparabile`, che si dichiara esplicitamente solo a fine ciclo).
- **Endpoint nuovi**: `POST /api/outbox/return-box` (rientro box intera); `POST /api/outbox/:box_serial/transform-cliente` (box `in_deposito`→`uscita_cliente` stesso seriale, **richiede omogeneità esito**, altrimenti 409 con lista FR non conformi); `GET /api/outbox/:box_serial/history`.
- **Endpoint modificati**: `/return` (FR-per-FR) a rientro completo → `in_deposito` + `box_history`; `DELETE /items/:fr` e `DELETE /:box_serial` (gestiscono `in_deposito`: rimozione = scioglie FR; delete box bloccata con suggerimento); `/assign` (target ammessi `creato` **e** `in_deposito`; per `in_deposito` l'FR resta `rientrato`); `/deposito` (include FR in box `in_deposito`); `/assignable-boxes` (include box `in_deposito` con capienza, output con `stato`/`esito`); `PATCH /:box_serial` (tipo) e `PATCH /:box_serial/stato` (bloccano `in_deposito` con suggerimento "Trasforma in uscita cliente").
- **Frontend `outbox.html`**: badge `in_deposito` (blu); tab Rientro con nuova card **"Rientro box intera"** (seriale + DDT opz) sopra al rientro FR singoli; tab Deposito riorganizzato in **3 sezioni** — **A** box create (non spedite al terzista), **B** box rientrate (`in_deposito`) **collassabili** (`<details>`) con lista FR + conteggi ok/sospesi/non-rip + azioni (sposta FR alla box destinazione, sciogli FR, dichiara non riparabile, trasforma in uscita cliente, apri in Consulta), **C** FR liberi; Consulta Box con sezione **"Trasforma in uscita cliente"**, sezione **"Storico box"** (timeline eventi), rimozione FR (x) abilitata per `in_deposito`.
- **Backup**: `backups/pre_in_deposito_20260829_101350.sql`; `server.js.bak_20260829_101350`; `public/outbox.html.bak_20260829_101350`.
- **Test end-to-end** (su box temporanea RBOX-9999/9998 con FR finti, poi puliti): create -> ship -> return-box -> set esiti -> transform (fail per non conforme) -> sciogli FR -> transform OK -> spostamento FR tra box `in_deposito`. Tutto verificato; dati di test rimossi; RBOX-0009 ripristinata a 0 FR.
- **TODO residui**: test in produzione del flusso completo su box reali (rientro box intera, spostamento FR, trasformazione); caso RBOX-0009 (box vuota in_deposito, decidere se archiviarla); storico FR/SN (vista); filtro dashboard; report/export dashboard.

### Sessione del 2026-09-17 (stato box nel PDF distinta + fix Content-Disposition)

- **Stato box nell'header del PDF distinta**: l'endpoint `/api/outbox/:box_serial/pdf` ora mostra una riga "Stato" nell'info-box con etichetta leggibile (mappa `statoLabels`):
  - `creato` → "Creato (in attesa spedizione terzista/cliente)" (in base a `tipo`)
  - `spedito` → "Spedito al terzista" / "Spedito al cliente" (in base a `tipo`)
  - `in_deposito` → "Rientrato dal terzista — in deposito"
  - `completato` → "Completato (deprecato)"
  - Fallback: se stato non riconosciuto, mostra il valore raw.
- **Titolo documento dinamico**: prima hardcoded "Distinta Box — Uscita verso terzista"; ora `docTitleLabel` si adatta al `tipo` box ("Uscita verso terzista" / "Uscita verso cliente").
- **Fix Content-Disposition: inline → attachment**: entrambi gli endpoint PDF (`/api/pdf-collaudo/:ext_sn` e `/api/outbox/:box_serial/pdf`) passati da `Content-Disposition: inline` ad `attachment`. Il frontend usa `<a download>` per i PDF; `inline` (mostra inline) in conflitto con `a.download` (forza download) causava fallimenti intermittenti in Chrome ("Controlla la connessione a Internet"), in particolare su RBOX-0015. Con HTTPS attivo, `attachment` non genera più l'avviso "download pericoloso" (il problema originale che aveva motivato `inline`). Ora tutti i download (PDF/CSV/TXT) usano coerentemente `attachment`.
- **Backup**: `server.js.bak_20260917_status_pdf` (pre-modifiche di questa sessione).

## Stato attuale

- ✅ Sistema box fully functional: creazione, modifica/eliminazione (se non spedita), spedizione con DDT opzionale, rientro con DDT per FR, spostamento FR, dashboard
- ✅ Workflow completo verificato: terzista → rientro → box `in_deposito` (test end-to-end con API)
- ✅ Etichetta box Zebra con QR ingrandito + ristampa da Consulta Box
- ✅ DDT di uscita opzionale + inseribile/modificabile dopo la spedizione
- ✅ DDT di rientro per singolo FR (inseribile e modificabile)
- ✅ Ricerca verifica per SN o FR; FR in riepilogo e report (N/A per record storici)
- ✅ Link "verifica FR" da Crea Box (chip) e Consulta Box (tabella) → pagina Stampa
- ✅ Gestione FR fuori scatola (deposito): assegnazione/spostamento da Verifica & Stampa e da tab Deposito
- ✅ **Rientro box intera** dal terzista (`/api/outbox/return-box`) + rientro FR-per-FR mantenuto
- ✅ **Deposito box rientrate** (`in_deposito`): spostamento FR tra box, scioglimento FR, riempimento fino a 24, sezione collassabile nel tab Deposito
- ✅ **Trasformazione box `in_deposito` → `uscita_cliente`** (stesso seriale, storico preservato via `box_history`), con validazione omogeneità esito
- ✅ **`box_history`**: storico eventi box (migrazione, rientro, trasformazione) + endpoint `/history`
- ✅ Servizio systemd attivo e funzionante
- ✅ **HTTPS** attivo su `https://10.11.12.8:3344` (certificato self-signed, eccezione da accettare al primo accesso browser)
- ✅ PDF distinta box: data spedizione visibile, paginazione 20 FR/pagina, footer rimosso
- ✅ **Stato box visibile nel PDF distinta** (etichetta leggibile + titolo dinamico terzista/cliente)
- ✅ **Download PDF affidabile**: `Content-Disposition: attachment` + HTTPS (risolve fallimenti intermittenti in Chrome)
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
- **Accesso DB da remoto (pg_hba.conf)**: i client esterni devono essere autorizzati in `/etc/postgresql/17/main/pg_hba.conf` (subnet/IP ammessi: `10.11.12.0/24`, `10.2.0.0/20`, `172.16.0.0/24`, `95.230.187.122/32`) con `scram-sha-256`; dopo una modifica serve `sudo systemctl reload postgresql`. Un IP pubblico non autorizzato produce `FATALE: nessuna voce in pg_hba.conf per l'host ...` anche se il firewall inoltra correttamente. Backup pg_hba in `.bak_*`.
- **Chromium**: richiesto installato sul server per generazione PDF (`chromium --headless`)
- **Zebra**: connessione TCP RAW su 10.2.0.6:9100, timeout 5 secondi
- **CUPS**: stampante A4 configurata come `CollaudioA4`
- **Cancellazione box**: `DELETE FROM outbound_boxes` cascade-deleta anche `outbound_box_items`, ma i record in `rientri` rimangono (FK con ON DELETE SET NULL) — per pulizia completa serve `DELETE FROM rientri` esplicito
- **Reset sequenze**: dopo DELETE totale, usare `SELECT setval('seq_name', 1, false)` per ripartire da 1
- **Script bash V2.0**: eseguito da WSL, richiede `sshpass` e `postgresql-client`; lo script si collega via SSH al gateway (utente `sgw`) e scrive nel DB remoto
- **DDT rientro vs uscita**: DDT di uscita è a livello di box (`outbound_boxes.ddt_uscita`); DDT di rientro è a livello di FR (`outbound_box_items.ddt_rientro` + audit in `rientri.ddt_rientro`) — perché una box può rientrare parzialmente/in tempi diversi.
- **Promote vs creazione manuale**: il promote sposta in blocco gli FR rientrati in una nuova box uscita_cliente; la creazione manuale (scan FR) resta disponibile per le spedizioni mirate con pochi pezzi.
- **in_deposito vs trasformazione vs promote**: una box terzista rientrata va in stato `in_deposito`. Da lì: (a) **trasformazione** (`/transform-cliente`) la converte in `uscita_cliente` **mantenendo lo stesso seriale** e lo storico (`box_history`), richiedendo esito omogeneo; (b) **promote** crea una **nuova** box `uscita_cliente` spostando gli FR rientrati di un dato esito, lasciando la terzista vuota come storico (poi archiviabile). Sui FR di una box `in_deposito` si può operare (spostare ad altra box `in_deposito`/`creato`, sciogliere → FR libero, dichiarare non riparabile) prima di spedire al cliente.
- **Eliminazione box `in_deposito`**: non ammessa via API (la box ha storico di spedizione/rientro). Per rimuoverla: spostare/sciogliere tutti gli FR, poi archiviare la box vuota. La cancellazione diretta è riservata alle box `creato`.
- **Archiviazione**: si archiviano solo box vuote (0 FR); restano rintracciabili in Consulta Box (per seriale) ma spariscono dal tab Stato.
- **Backup DB**: dump di sicurezza in `refurb_label_App/backups/` (gitignored). Ripristino: `psql -f backups/<file>.sql`
- **HTTPS / TLS**: l'app serve su HTTPS (porta 3344) con certificato self-signed in `certs/` (valido 10 anni, SAN `IP:10.11.12.8`). Il primo accesso browser richiede accettazione manuale dell'eccezione di sicurezza. I vecchi bookmark `http://` vanno aggiornati a `https://`. I certificati non sono in git (gitignored).
- **PDF download**: `Content-Disposition: attachment` + `Content-Length` su entrambi gli endpoint PDF. In precedenza si usava `inline` (per evitare blocchi Chrome su HTTP), ma creava conflitto con `a.download` del frontend causando download intermittenti falliti. Con HTTPS, `attachment` è la scelta corretta e coerente con CSV/TXT.
- **PDF distinta box**: paginazione a 20 FR per pagina (`page-break-after: always`); la numerazione è continua across le pagine; l'intestazione tabella si ripete su ogni pagina. Footer rimosso.

## Casi in sospeso (2026-08-24, verifica reale)

- **RBOX-0009 — incongruenza da indagare/risolvere**:
  - Box uscita_terzista in stato completato ma con 0 FR associati (items vuoti).
  - In rientri esiste un record per FR62676 rientrato da RBOX-0009 (DDT 756/26, 2026-08-11 11:49) con outbound_item_id = NULL: la riga outbound_box_items di FR62676 e stata eliminata in passato (FK ON DELETE SET NULL ha staccato l'audit).
  - FR62676 e l'unico FR reale in device_tests (ext_sn 80000558, esito OK, techbase). Tutti gli altri FR nelle box 0001-0008/0010-0013 sono FR REALI ma non in device_tests (vedi NOTA IMPORTANTE sotto).
  - Probabilmente test dei colleghi. Lasciata in sospeso (non modificata) in attesa di decisione: ripristinare l'item di FR62676, oppure archiviare la box vuota.

- **NOTA IMPORTANTE (correzione 2026-08-24)**: gli FR associati a TUTTE le box attualmente presenti (0001-0008, 0010-0013, 288 FR) sono **FR REALI**, non dati di test. Tuttavia NON sono presenti in device_tests (l'unico FR in device_tests resta FR62676). Quindi i FR reali vengono gestiti nel sistema box senza un record di collaudo in device_tests.
- **Conseguenza critica per RBOX-0014 (box eliminata)**: i suoi FR, essendo reali ma non in device_tests, dopo la DELETE CASCADE sono **scomparsi del tutto e non risultano in /api/deposito** (il deposito elenca solo FR presenti in device_tests non assegnati a box). Da verificare se serve un nuovo endpoint "deposito" basato sugli FR reali noti anche senza device_tests.

### Sessione del 2026-08-24 (anagrafica FR + esito + modifica stato box)

- **`fr_registry` (anagrafica FR)**: nuova tabella master del ciclo di vita dell'FR (fr PK, ext_sn, sn, esito, stato, tentativi, data_creazione, data_rientro, note). Disaccoppia l'FR dal collaudo: un FR esiste dalla stampa etichetta, prima di qualsiasi `device_tests`.
  - **Stati** (`fr_registry.stato`): `deposito` | `in_box_terzista` | `in_box_cliente` | `spedito_cliente`.
  - **Esito** (`fr_registry.esito`, manuale): `null` (in sospeso) | `riparato` | `non_riparabile`. Un NOK NON imposta automaticamente l'esito: l'operatore decide (dichiarare non riparabile o ritentare). Un OK → `riparato`.
  - `ext_sn` attribuito dal terzista via script V2.0: parte `null`, popolato al rientro dal `device_tests`.
  - `tentativi`: # volte spedito al terzista (incrementa a ogni spedizione, decrementa su un-ship).
- **`outbound_boxes.esito`**: nuova colonna. `null` per `uscita_terzista`; `riparato`/`non_riparabile` per `uscita_cliente`. Le box verso cliente sono **separate** per esito (FR omogenei).
- **Backfill**: 288 FR reali (prima spedizione al terzista, in box spedita/creato) importati in `fr_registry` (stato `in_box_terzista`, esito null). FR62676 (caso RBOX-0009) inserito manualmente (`deposito`, `riparato`, ext_sn 80000558). Totale 289 FR in anagrafica. Dati reali preservati.
- **Endpoint nuovi**: `GET /api/fr/:fr` (storico FR: registry + collaudi + box + rientri); `PATCH /api/fr/:fr/esito` (esito manuale); `PATCH /api/outbox/:box_serial/stato` (modifica stato box: `creato`<->`spedito`; un-ship annulla `data_spedizione`+`ddt_uscita`, items→raccolto, FR tornano in deposito nella box, `tentativi` decrementati).
- **Endpoint modificati**: `/api/print-fr` (upsert `fr_registry` stato deposito alla stampa etichetta); `/api/deposito` (riscritto su `fr_registry`: FR nel mio magazzino = sciolti/rientrati + FR in box `creato`); `/api/verify` (lookup `fr_registry` + `device_tests`; gestisce FR senza collaudo); `/api/outbox/create`+`assign`+`assign-new` (validano/creano anagrafica, sync `fr_registry.stato`, esito omogeneo per box cliente); `/api/outbox/ship` (`tentativi++` terzista / `spedito_cliente`); `/api/outbox/return` (registry→`deposito`, esito da collaudo OK=`riparato`/NOK=null, ext_sn da device_tests); `/api/outbox/:box_serial/promote` (richiede `esito`, muove solo FR con quell'esito, box cliente con esito); `DELETE` box/items (FR→`deposito` in registry, non spariscono più); `GET /api/outbox/:box_serial` + dashboard (mostrano `esito`).
- **Frontend**: `outbox.html` — selettore esito in Crea Box (cliente), colonna Esito in Consulta Box e Deposito, tab Deposito con esito/tentativi/box, azione "dichiaro non riparabile", sezione "Annulla spedizione" (un-ship) per box spedita, prompt esito nel promote, `createEmptyBox` con tipo+esito. `index.html` — verifica mostra stato/esito FR; gestisce FR in deposito senza collaudo.
- **Backup**: dump `backups/pre_fr_registry_20260824_125916.sql`; `server.js.bak_20260824_125916`.
- **TODO residui**: test in produzione del flusso completo (deposito→box terzista→spedizione→collaudo→rientro→esito→box cliente separata); un-ship su box reali; storico FR/SN (vista); filtro dashboard; report/export dashboard.

- **RBOX-0014 ricreata (2026-08-24)**: box eliminata in un test precedente (FR persi via CASCADE, non in fr_registry). Ricreata via Crea Box (seriale 0014, uscita_terzista, stato creato) con 7 FR reali recuperati dall'operatore. FR inseriti in fr_registry (in_box_terzista, esito null) + outbound_box_items (raccolto). Risultano in deposito (box creato). Totale: fr_registry 296, outbound_boxes 14, outbound_box_items 295.
- **UI Deposito raggruppata**: FR in box compattati per box (una riga per box creato, con tasto Apri in Consulta Box); solo gli FR liberi (senza box) mostrati singolarmente con azioni assegna/dichiara non riparabile. Commit `cba68a5`.
