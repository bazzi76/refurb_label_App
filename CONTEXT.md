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

### Sessione del 2026-11-12 (indagine errore di rete su assegnazione FR a box cliente)

- **Problema segnalato**: il collega cerca di assegnare FR a una box `uscita_cliente` (per rispedire al cliente finale) e ottiene "Errore di rete", ma la connessione funziona (la pagina carica).
- **FR coinvolti**: inizialmente FR10962, FR13863; poi estesi a 7 (FR46389, FR13274, FR37897, FR47912, FR18369, FR10962, FR13863).
- **Diagnosi server-side**:
  - Processo Node sano (up 7h, 90MB RSS, nessun OOM, nessun restart anomalo); Pool pg default (max 10).
  - Tutti gli endpoint coinvolti (`/api/outbox/assign`, `/assign-new`, `/create`, `/assignable-boxes`, `/deposito`) testati via curl: rispondono **sempre JSON valido**.
  - Riprodotta la creazione esatta del collega (Crea Box, 7 FR, `uscita_cliente`/`riparato`) via curl: **200 OK**, "Box creato con 7 FR associati". Server a posto al 100%.
  - **Nessun log** dal servizio nei 30 min attorno al tentativo del collega: la richiesta verosimilmente **non e mai arrivata al server** (l'endpoint `create` logga solo sui 500, non sui 4xx ne sui successi).
  - I 7 FR sono tutti validi: presenti in `fr_registry`, esito `riparato` (omogeneo), in `deposito`, nessun conflitto cross-box.
- **Conclusione**: l'"Errore di rete" e il `catch(err)` del frontend, che scatta quando `fetch()` o `res.json()` lanciano eccezione. Poiche il server risponde sempre JSON, la causa e **browser-server** (es. URL `http://` invece di `https://`, eccezione cert self-signed non accettata per le chiamate API, rete remota instabile). Da verificare con F12 -> Network.
- **Operazioni DB eseguite** (con approvazione utente):
  - Cancellate **RBOX-0034** (id 48, `in_deposito`, 0 FR) e **RBOX-0035** (id 49, `uscita_cliente`/`creato`, 1 FR) - create per errore. RBOX-0035 era stata creata da me in un test diagnostico (assegnazione FR10962). CASCADE: item eliminati, `rientri` preservati con `outbound_item_id=NULL`, `box_history` rimosso.
  - L'utente ha sciolto 3 FR da RBOX-0022 (FR13863, FR46389, FR47912) -> tutti correttamente a `deposito`, esito `riparato`. RBOX-0022 scesa da 24 a 21 FR.
  - FR10962 rimesso a `deposito` (era `in_box_cliente` per il mio test).
  - Verificata consistenza DB: 0 item orfani, 0 mismatch `fr_registry.stato` vs box reale, 55 FR liberi in deposito.
- **Bug trovato (non ancora fixato)**: `index.html` `assignNewBox()` invia `{ fr, tipo }` **senza `esito`** -> creare una box `uscita_cliente` dalla pagina Verifica & Stampa fallisce sempre con 400 "esito obbligatorio". Il tab Crea Box in `outbox.html` invece invia `esito` correttamente. Da fixare (aggiungere selettore esito o dedurlo da `fr_registry`).
- **RBOX-0022**: ancora 2 FR con esito NULL (FR25751, FR32054) -> bloccherebbero la trasformazione in `uscita_cliente` (non rilevante per il flusso attuale di estrazione FR, ma da risolvere se si vuole trasformare la box intera).
- **Test rimandati a domani**: verifica browser F12 -> Network per pinpointare l'errore di rete del collega (URL http/https, eccezione cert self-signed, status della richiesta `create`).

### Sessione del 2026-11-13 (fix creazione box uscita_cliente — root cause trovata)

- **Problema**: creazione di box `uscita_cliente` falliva sempre con "Errore di rete" da entrambe le pagine (Crea Box in `outbox.html` e Verifica & Stampa in `index.html`). Nessun errore visibile in console Chrome. Il problema esisteva fin dalla introduzione del campo esito (sessione 2026-08-24) — **nessuna box `uscita_cliente` era mai stata creata con successo**.
- **Diagnosi**:
  - Server sano: endpoint `/api/outbox/create` e `/api/outbox/assign-new` rispondono sempre JSON valido (testato via curl con 20 FR reali, 200 OK in 18ms).
  - **Root cause `outbox.html`**: la variabile `boxEsitoSelect` **non era mai dichiarata** nel JS (manca `const boxEsitoSelect = document.getElementById(...)`). Quando `tipo === 'uscita_cliente'`, la riga `boxEsitoSelect.value` in `Object.assign(...)` lancia `ReferenceError` **dentro il try**, catturato dal catch → mostra "ERRORE DI RETE". La `fetch` non veniva mai chiamata (nessun log server-side, nulla in console perché il catch non ha `console.error`).
  - **Bug secondario `outbox.html`**: il wrapper `esito-select-wrap` era sempre `hidden` — mancava il listener per mostrarlo al cambio tipo.
  - **Bug `index.html`**: `assignNewBox()` inviava `{ fr, tipo }` **senza `esito`** → 400 "esito obbligatorio" dal server. Inoltre non c'era alcun selettore esito nella UI di Verifica & Stampa.
- **Fix `outbox.html`** (3 modifiche):
  - Dichiarata `const boxEsitoSelect = document.getElementById('box-esito-select')`.
  - Aggiunto `toggleEsitoWrap()` + listener `change` su `boxTipoSelect` per mostrare/nascondere il selettore esito.
  - Aggiunto `console.error("createBox error:", err)` nel catch di `createBox()`.
- **Fix `index.html`** (6 modifiche):
  - Aggiunto `<select id="assign-new-esito">` (Riparato/Non Riparabile) nella sezione Gestione box, visibile solo per `uscita_cliente`.
  - Aggiunta variabile globale `currentRegEsito`; dopo verify viene salvato `reg.esito` e pre-selezionato il dropdown.
  - `assignNewBox()` ora invia `esito` nel payload quando `tipo === 'uscita_cliente'` (via `Object.assign`).
  - Aggiunto `console.error` nel catch di `assignNewBox()`.
- **Verifica**: l'utente ha creato con successo **RBOX-0034** (`uscita_cliente`/`riparato`, 20 FR) dal tab Crea Box dopo il fix. Prima box `uscita_cliente` mai creata nel sistema.
- **Backup**: `outbox.html.bak_20261113_esito`; `index.html.bak_20261113_esito`.
- **Commit**: `3631436` — fix(ui): box uscita_cliente — selettore esito + variabili non dichiarate. Pushato su `origin/main`.

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
- ✅ **Operatore collaudatore fisso** nel PDF/verbale di collaudo: nome "Lorenzo Bigazzi" stampato nel box firma
- ✅ **Creazione box `uscita_cliente` funzionante** da Crea Box (`outbox.html`) e Verifica & Stampa (`index.html`): selettore esito, validazione omogeneità, pre-selezione da `fr_registry`
- ✅ Tutte le modifiche committate e pushate su `origin/main` (ultimo commit: `3631436`)

## TODO / questioni aperte

- **FR "Non Riparabile"** (futura gestione): alcuni gateway non conviene ripararli e vanno rispediti al cliente con dicitura "Non Riparabile".
  - Non avranno un risultato di `gateway_test_V2.0.sh` (nessun collaudo in `device_tests`).
  - Probabilmente rientrano insieme a fine ciclo di lavorazione (lotti da 100 verso il terzista) o dopo un paio di lotti.
  - Serve tenerne traccia per rendicontare al cliente (stato/etichetta dedicata, flusso di uscita cliente marcato "Non Riparabile", eventuale report).
  - Da definire: come contrassegnarli (flag in `device_tests`/`outbound_box_items`? tipo box dedicato?), come gestirli nel rientro e nel dashboard, ed eventuale dicitura su etichetta/report.
- **Storico FR / SN** (uso interno/statistico): vista che, dato un FR o uno SN, ricostruisce il suo percorso (box terzista, spedizioni, rientri, DDT, date) aggregando `device_tests` + `outbound_box_items` + `rientri`. Da progettare.
- **RBOX-0022 - 2 FR con esito NULL** (FR25751, FR32054): vanno sciolti/spostati o marcati con esito prima di poter trasformare la box in `uscita_cliente`.
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

### Sessione del 2026-10-15 (indagine perdita dati giugno + retention backup 90gg)

- **Retention backup aumentata a 90 giorni**: modificato `/home/giacomo/backup_postgres.sh` (`RETENTION_DAYS` da 30 a 90). Il cron giornaliero alle 02:00 ora mantiene 90 giorni di dump su NAS. Modifica effettiva da subito, nessun riavvio necessario.

- **Problema segnalato dal cliente**: 2 dispositivi con **stesso SN `b827eb2710eb`** ma ext_sn e ICCID diversi. Indagine avviata per fare chiarezza.

- **Indagine DB — risultati**:
  - **`b827eb2710eb` completamente assente** dal DB: non in `device_tests`, `SGW_Lora_log`, `fr_registry`, `shipments`, `badge_events` né alcunaltra tabella. SN vicini nel range b827eb27* esistono ma questo specifico è sparito.

### Sessione del 2026-10-15 (indagine perdita dati giugno + retention backup 90gg)

- **Retention backup aumentata a 90 giorni**: modificato `/home/giacomo/backup_postgres.sh` (`RETENTION_DAYS` da 30 a 90). Il cron giornaliero alle 02:00 ora mantiene 90 giorni di dump su NAS. Modifica effettiva da subito, nessun riavvio necessario.

- **Problema segnalato dal cliente**: 2 dispositivi con stesso SN `b827eb2710eb` ma ext_sn e ICCID diversi. Indagine avviata per fare chiarezza.

- **Indagine DB - risultati**:
  - **`b827eb2710eb` completamente assente** dal DB: non in `device_tests`, `SGW_Lora_log`, `fr_registry`, `shipments`, `badge_events` ne alcun'altra tabella. SN vicini nel range b827eb27* esistono ma questo specifico e sparito.
  - **Gap temporale confermato 10-18 giugno 2026**: ultimo record prima del gap = id 756 (10 giu 17:32, SN b827ebf9fdaf); primo record dopo = id 811 (18 giu 09:55, SN b827eb4a6036). Nessun record dall'11 al 17 giugno. Salto di 54 ID (757-810).
  - **54 ID "mancanti" (757-810) reinseriti a fine luglio**: gli ID 757-810 esistono ma con date di luglio (28-30 lug), non giugno. Probabile re-import manuale successivo all'evento di perdita dati. Il recupero e stato **incompleto**: `b827eb2710eb` era tra i record persi e non e stato recuperato.
  - **27 SN con ext_sn diversi**: stesso SN fisico a cui sono stati assegnati ext_sn differenti nel tempo. Casi piu gravi:
    - `b827eb51c7a7`: 3 ext_sn (80000748/80000775/80000786), tutti il 19 giu in 4 minuti
    - `b827ebc1a777`: 2 ext_sn (80000254/80000413), 3 ICCID diversi, 9 giu
    - `90e2fc700360`, `b827eb7c9d99`, `b827eb65b648` e altri 23
  - **30 ext_sn condivisi tra SN diversi**: alcuni solo differenze maiuscolo/minuscolo, altri SN realmente diversi con stesso ext_sn (problema tracciabilita).
  - **Totali DB**: 1658 record, 1173 SN univoci, 279 SN con record duplicati (molti normali = retest dopo NOK).
  - **Altri gap ID**: id 1-2 mancanti (primi record, probabilmente test iniziali); id 1326 mancante (1 record, agosto, probabile delete manuale in test).
  - **Log PostgreSQL non disponibili**: rotazione arrivata solo ad agosto, log di giugno cancellati.
  - **Nessun backup pre-agosto**: impossibile confrontare con stato originale del DB a giugno. Backup manuali piu vecchi = 11 ago; backup NAS piu vecchio superstite = 20 set (30gg retention precedente).

- **Ipotesi ricostruttiva**: un collaboratore ha causato perdita dati ~10-15 giugno (DELETE accidentale, script errato o altro). ~54 record persi. Recupero parziale a fine luglio con re-import manuale (ID 757-810) ma dati potenzialmente inaccurati -> SN/ext_sn mischiati. `b827eb2710eb` non recuperato.

- **In attesa**: il collaboratore ha un backup che dovrebbe inviare in giornata. Prossima sessione: confrontare il backup con il DB attuale per identificare i record persi/corrotti e pianificare il ripristino selettivo.

- **TODO**:
  - Ricevere e analizzare il backup del collaboratore (pre-10 giugno)
  - Confrontare backup vs DB attuale: identificare record persi (54 ID), record con SN/ext_sn scambiati
  - Valutare ripristino selettivo dei record corretti
  - Aggiungere vincolo UNIQUE su `sn` in `device_tests` per prevenire duplicati futuri (dopo ripristino)
  - Valutare se i 27 SN con ext_sn multipli necessitano correzione manuale
  - Verificare attendibilita dei 54 record reinseriti (ID 757-810, date luglio)


### Sessione del 2026-10-16 (analisi backup collaboratore + indagine SN b827eb2710eb)

- **Backup recuperato dal collaboratore**: file `backups/gmattei/device_tests_10-11-12-8_before_id_overwrite_20260730-161628.json` (28K). Documenta lo stato PRIMA di un'operazione di sovrascrittura del 30 luglio 2026.

#### Struttura del backup

- **`old_rows`**: 54 record originali (ID 757-810) con **date di giugno 2026** (11-18 giu), SN in **minuscolo** (`b827eb...`). Questi sono i dati ORIGINALI che sono stati sovrascritti. Sono l'unica copia superstite dei record di giugno.
- **`appended_rows`**: 54 record (ID 1322-1375) con **date di luglio 2026** (28-30 lug), SN in **MAIUSCOLO** (`B827EB...`). Questi sono i record che sono stati copiati dentro 757-810 (sovrascrivendo i dati di giugno), poi cancellati da 1322-1375.
- **Operazione descritta nel JSON**: `"replace target IDs 757-810 and remove copied IDs 1322-1375"`.

#### Ricostruzione dell'evento

1. **Giugno**: 54 record regolari (ID 757-810), date 11-18 giu, SN minuscoli.
2. **~Fine luglio**: qualcuno inserisce 54 nuovi record (ID 1322-1375) con date 28-30 lug, SN maiuscoli.
3. **30 luglio 16:16**: operazione di sovrascrittura — i dati di 1322-1375 vengono scritti dentro 757-810 (date giugno->luglio, SN minuscolo->maiuscolo), poi 1322-1375 vengono cancellati.
4. **Dopo luglio**: nuovi record diversi vengono inseriti negli ID 1322-1375 (dati di agosto, altri dispositivi). ID 1326 risulta mancante.
5. **Risultato attuale**: ID 757-810 contengono i dati di luglio; i dati originali di giugno sono perduti se non nel backup.

#### Confronto backup vs DB attuale

- **DB attuale**: 1658 record, max ID 1661, 1173 SN univoci, 280 ext_sn duplicati.
- **SN dei old_rows (giugno)**:
  - **21 SN univoci completamente assenti dal DB** (esistevano solo nei 54 record di giugno, ora persi). Include `b827eb2710eb` (3 record), `b827eb15ed31` (4 record), `b827eb1ef110`, `b827eb6061d1`, `b827eb8beeaf`, `b827eb619634`, ecc.
  - **12 SN esistono altrove** nel DB (altri ID/date, es. retest successivi) — ma i loro record di giugno 11-18 sono comunque persi.
- **Record di luglio (attualmente in 757-810)**:
  - **48 su 54** hanno ext_sn che esiste **solo** in 757-810 (unici, non duplicati altrove).
  - **6 record** hanno ext_sn duplicato altrove (ID 1277-1318), ma con differenze (esito diverso in 4 casi, quasi-duplicato in 2).
  - I record di luglio in 757-810 hanno `data_stampa` aggiornata dopo l'overwrite (etichette stampate 30-31 lug), quindi rappresentano attivita reale successiva all'overwrite.
- **Campo `fr`**: assente sia nei `old_rows` che negli `appended_rows` (colonna aggiunta dopo, sessione 8-10 ago).

#### Impact su box_items (corruzione referenziale)

- **45 box_items** in 3 box (BX202609010016, BX202609010017, BX202609020001, create 1-2 set 2026) puntano a `device_tests.id` nel range 757-810 via `shipment_id`.
- Dopo l'overwrite, questi box_items referenziano i **dispositivi di luglio** (dati sovrascritti), non i dispositivi di giugno originali.
- Le box sono state create a settembre lavorando con i dati di luglio (l'operatore ha scansionato/testato i dispositivi di luglio), quindi i box_items sono coerenti con il dato attuale — ma il collegamento ai record di giugno originali e perso.

#### Indagine SN b827eb2710eb (segnalazione cliente)

- **Segnalazione**: il cliente trova lo stesso SN `b827eb2710eb` in due file di spedizione con ext_sn e ICCID diversi:
  - **Medinok - CT, 02/07/2026**: ext_sn 80000715, ICCID 89390100002365490055, INSTALLATO a I022RG (confermato da foto SGM)
  - **Telebit - TO, 08/07/2026**: ext_sn 80000686, ICCID 89390100002384466474, IN GIACENZA
- **Cronologia del dispositivo** (dal backup `old_rows`): `b827eb2710eb` e stato collaudato **3 volte** a giugno, ogni volta con ext_sn e ICCID diversi (ri-provisioning progressivo):
  - 12 giu 14:16: ext_sn **80000686**, ICCID ...84466474, etichetta stampata 17 giu -> spedito a **Telebit 08/07**
  - 12 giu 16:10: ext_sn 80000702, ICCID ...84466151, etichetta mai stampata -> non spedito
  - 17 giu 15:29: ext_sn **80000715**, ICCID ...65490055, etichetta stampata 25 giu -> spedito a **Medinok 02/07**
- **Conclusione**: `b827eb2710eb` e il SN **corretto per ext_sn 80000715** (Medinok, confermato installato). Il SN `b827eb2710eb` nella spedizione Telebit (ext_sn 80000686) e **errato** — si riferisce al primo provisioning del dispositivo, successivamente sostituito. Lo stesso SN fisico non puo essere in due posti.
- **ext_sn 80000686**: usato da **2 dispositivi diversi** nei `old_rows`:
  - ID 758: SN b827eb8fd914, ICCID ...69861558, 11 giu (primo utilizzo)
  - ID 761: SN b827eb2710eb, ICCID ...84466474, 12 giu (riassegnato a dispositivo/SIM diversi)
  - Nel DB attuale, b827eb8fd914 esiste con ext_sn 80000690 (ID 729, 10 giu). ext_sn 80000686 e **completamente assente** dal DB attuale.
- **ICCID 89390100002384466474** (SIM spedizione Telebit): ricompare nel DB a ID 1319 (SN b827eb3adcb6, ext_sn 80001108, 28 lug) — la SIM e stata spostata su un altro dispositivo (normale nel refurb).
- **ICCID 89390100002365490055** (SIM spedizione Medinok): non compare in nessun altro record del DB attuale.
- **SN b827eb2710eb**: completamente assente dal DB attuale (tutti e 3 i record erano negli ID 761, 763, 773, tutti sovrascritti).
- **Risposta al cliente**: non e possibile identificare con certezza il SN corretto per ext_sn 80000686 nella spedizione Telebit. L'unico SN noto per ext_sn 80000686 + ICCID ...66474 e b827eb2710eb, ma questo e confermato installato a Medinok con ext_sn 80000715. Il dispositivo effettivamente spedito a Telebit con ext_sn 80000686 e un altro gateway il cui SN non e tracciato nel DB a causa della perdita dati del 30 luglio.

#### Tabelle DB aggiuntive scoperte (non documentate prima)

Oltre a `device_tests`, `outbound_boxes`, `outbound_box_items`, `rientri`, `fr_registry`, `box_history`, il DB contiene:
- **`shipments`** (id, sn, destination, notes, scanned_at) — per ora vuota per i SN in questione
- **`destinations`** (id, name, created_at) — destinazioni: Deposito, BH MASSA, BH VIBO VALENTIA, BH AVENZA, PLURES sede FERRALE
- **`boxes`** (id, box_sn, destination, items_count, notes, created_at) — box di spedizione
- **`box_items`** (box_id, shipment_id FK->device_tests.id, position, added_at) — item nelle box
- **`master_boxes`** (id, master_sn, destination, items_count, notes, created_at) — master box
- **`master_box_items`** (master_box_id, box_id, position, added_at) — item nei master box
- **`SGW_Lora_log`** (id, esn, station_eui, iccid, esito_test, data_test) — log test LoRaWAN (151 record, campo `esn` non corrisponde a SN/ext_sn)
- **`badge_events`** — eventi badge

#### Opzioni di ripristino (non ancora eseguite)

- **Opzione A (consigliata)**: inserire i 54 `old_rows` come nuovi record (nuovi ID), preservando i 54 record di luglio attuali. Nessun dato perso, nessun rischio. Crea duplicati di SN per i 12 che esistono gia altrove (normale: retest). I 21 SN assenti tornano a esistere.
- **Opzione B**: ripristinare 757-810 ai dati di giugno + re-inserire i 48 record unici di luglio come nuovi. Piu complessa, rischiosa.
- **Opzione C (ibrida)**: inserire old_rows come nuovi record, poi valutare se i 48 record di luglio in 757-810 sono reali o artefatti dell'operazione errata.
- **In sospeso**: decidere strategia con il cliente. Per ora **nessuna modifica al DB**.

#### TODO aggiornati

- Decidere e eseguire ripristino dei 54 record di giugno (opzione da confermare)
- Rispondere formalmente al cliente re: SN b827eb2710eb / ext_sn 80000686 (spedizione Telebit)
- Valutare correzione dei 45 box_items che puntano a ID 757-810 (dopo ripristino, se si cambia strategia)
- Aggiungere vincolo UNIQUE su `sn` in `device_tests` (dopo ripristino) — attenzione: il ri-provisioning crea legittimamente SN duplicati con ext_sn diversi; valutare UNIQUE su `(sn, ext_sn)` o solo su `ext_sn`
- Documentare le tabelle `shipments`, `boxes`, `box_items`, `master_boxes`, `master_box_items`, `SGW_Lora_log`, `badge_events` nel CONTEXT
- Storico FR/SN (vista) — da progettare
- Filtro dashboard / report export dashboard
- FR "Non Riparabile" — flusso da definire

### Sessione del 2026-11-12 (nome operatore collaudatore fisso nel PDF collaudo)

- **Operatore collaudatore fisso nel PDF/verbale di collaudo**: in `buildCollaudoHTML` (`server.js`), il box firma "Operatore collaudatore" ora stampa il nome **Lorenzo Bigazzi** sopra la riga di firma (font 11pt grassetto), mantenendo sotto la riga + etichetta "Operatore collaudatore". Il box "Responsabile controllo qualità" resta invariato (firma manuale).
- **Backup**: `server.js.bak_20261112_operatore`; `CONTEXT.md.bak_20261112`.
- **Servizio riavviato**: `sudo systemctl restart refurb-labeler.service` (modifica a `server.js`).
- **Non ancora committato/pushato** (modifica locale sul server in attesa di istruzioni).
