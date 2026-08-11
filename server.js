// ==============================================================================
// server.js — Gateway Refurb Label App
// Avvio: node server.js
// Dipendenze: npm install
// ==============================================================================

const express = require('express');
const { Pool }  = require('pg');
const net       = require('net');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const { exec }  = require('child_process');

const app  = express();
const PORT = 3344;

// ------------------------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------------------------
const DB = new Pool({
  host:     '10.11.12.8',        // il DB è sullo stesso server Debian
  port:     5432,
  database: 'device_db',
  user:     'tester',
  password: 'GRPsmt.2014!',
});

const ZEBRA_IP    = '10.2.0.6';
const ZEBRA_PORT  = 9100;          // porta RAW standard Zebra

const CUPS_PRINTER = 'CollaudioA4';  // nome stampante CUPS (lpadmin -p CollaudioA4 ...)


// ------------------------------------------------------------------------------
// MIDDLEWARE
// ------------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------------------
// GENERA ZPL — template testato su Zebra 300dpi, etichetta 38,1x19,05mm
// ------------------------------------------------------------------------------
function buildZPL(sn, iccid, extSn) {
  return [
    '^XA',
    '^PW450',
    '^LL225',
    '^CI28',
    '^LH0,0',
    `^FO15,30^A0N,60,60^FDSim Tel Refurb^FS`,
    `^FO8,100^A0N,25,25^FDS/N Ext: ${extSn}^FS`,
    `^FO8,130^A0N,25,25^FDSN: ${sn}^FS`,
    `^FO8,170^A0N,25,25^FDICCID:^FS`,
    `^FO8,205^A0N,30,40^FD${iccid}^FS`,
    `^FO300,77^BQN,2,5^FDQA,${iccid}^FS`,
    '^XZ',
  ].join('');
}

// ------------------------------------------------------------------------------
// GENERA ZPL ETICHETTA BOX — 50,8 × 25,4 mm, QR code + testo leggibile
// ------------------------------------------------------------------------------
function buildBoxLabelZPL(boxSerial) {
  const prefix = boxSerial.substring(0, boxSerial.lastIndexOf('-') + 1); // "RBOX-OUT-"
  const num    = boxSerial.substring(boxSerial.lastIndexOf('-') + 1);   // "1234"
  return [
    '^XA',
    '^PW600',     // 50,8mm = 2" = 600 dot @300dpi
    '^LL300',     // 25,4mm = 1" = 300 dot @300dpi
    '^CI28',
    '^LH0,0',
    '^FO15,15^A0N,22,22^FDUscita Box^FS',
    `^FO15,45^BQN,2,10^FDQA,${boxSerial}^FS`,
    `^FO245,85^A0N,30,30^FD${prefix}^FS`,
    `^FO245,125^A0N,52,52^FD${num}^FS`,
    '^XZ',
  ].join('');
}

// ------------------------------------------------------------------------------
// INVIA ZPL ALLA ZEBRA VIA TCP RAW
// ------------------------------------------------------------------------------
function printLabel(zpl) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(5000);

    client.connect(ZEBRA_PORT, ZEBRA_IP, () => {
      client.write(zpl, 'utf8', () => {
        client.end();
      });
    });

    client.on('close', () => resolve());
    client.on('timeout', () => { client.destroy(); reject(new Error('Timeout connessione stampante')); });
    client.on('error',  (err) => reject(err));
  });
}

// ------------------------------------------------------------------------------
// GENERA HTML FOGLIO COLLAUDO A4
// ------------------------------------------------------------------------------
function buildCollaudoHTML(row) {
  const dataTest   = row.data        ? new Date(row.data).toLocaleString('it-IT')        : '—';
  const dataStampa = row.data_stampa ? new Date(row.data_stampa).toLocaleString('it-IT') : '—';
  const esitoOk    = row.esito_test === 'OK';
  const esitoColor = esitoOk ? '#1a7f37' : '#cf222e';
  const esitoBg    = esitoOk ? '#dafbe1' : '#ffebe9';
  const isTechbase = (row.sgw_type || '').toLowerCase() === 'techbase';

  // Codici NOK presenti nel record
  const nokCodes = (!esitoOk && row.esito_test && row.esito_test.startsWith('NOK:'))
    ? new Set(row.esito_test.replace('NOK:', '').split(','))
    : new Set();

  // Helper: restituisce la cella esito colorata
  const cell = (ok) => ok
    ? `<td class="check ok">&#10003;</td>`
    : `<td class="check nok">&#10007;</td>`;

  // ── ELECTRICAL CHECK (tutti manuali → sempre ✓) ──────────────────────────
  const electricalItems = [
    'Ispezione Visiva',
    'Power Supply Check',
    'Relay Out',
    'Opto Inputs',
    'Dry Contact Inputs',
    'Digital Out',
    'Analog Inputs',
    'Analog Outputs',
    'Ethernet',
    '1-Wire',
    'RS-232',
    'RS-485',
    ...(isTechbase ? [] : ['CAN (Edge only)']),
    'USB Port',
  ];

  const electricalRows = electricalItems.map(label => `
    <tr><td>${label}</td>${cell(true)}</tr>`).join('');

  // ── FINAL CHECK (dinamico, collegato ai codici NOK) ──────────────────────
  // Ogni voce: [ label, nokCode ] — nokCode=null significa always-ok (non tracciato dallo script)
  // Per i dispositivi: Edge ha RS485 (/dev/ttyRS485), Techbase ha SC0 (/dev/ttySC0)
  const finalItems = [
    ['Check RS-485 device',             isTechbase ? 'SC0' : 'RS485'],
    ['Hotspot service',                 'HTSP'],
    ['Apnchanger service',              'APN'],
    ['SSHD service',                    'SSH'],
    ['Raptor service',                  'RAPT'],
    ['Raptorwatchdog service',          'RAPTWD'],
    ...(isTechbase ? [['RS485ctl service (Techbase)', 'RS485SVC']] : []),
    ['Check wlan0',                     'WLAN'],
    ['Check wwan0',                     'WWAN'],
    ['Check /dev/ttyRaptor',            'RAPTDEV'],
    ['Profile wwantest (NM)',           'NM:WTEST'],
    ['Profile VODAFONE-IOT (NM)',       'NM:VFIOT'],
    ['LTE Connection',                  'LTE'],
  ];

  const finalRows = finalItems.map(([label, code]) => {
    const passed = !nokCodes.has(code);
    return `<tr><td>${label}</td>${cell(passed)}</tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    font-size: 10pt;
    color: #1a1a1a;
    padding: 14mm 16mm 18mm 16mm;
  }

  /* ── HEADER ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 2px solid #1a5fa8;
    padding-bottom: 8px;
    margin-bottom: 12px;
  }
  .header-brand { font-size: 17pt; font-weight: 700; color: #1a5fa8; letter-spacing: -0.5px; }
  .header-brand span { color: #e05c00; }
  .header-meta { text-align: right; font-size: 8pt; color: #555; line-height: 1.6; }
  .header-meta strong { font-size: 9.5pt; color: #1a1a1a; }

  /* ── SLOT ETICHETTA ZEBRA (38,1 × 19,05 mm) ── */
  .label-slot {
    width:  108px;   /* ~38mm a 72dpi */
    height:  54px;   /* ~19mm a 72dpi */
    background: #ffffff;
    border-radius: 3px;
    border: 1px solid #000000;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 3px;
    flex-shrink: 0;
  }
  .label-slot span {
    color: #000000;
    font-size: 6.5pt;
    letter-spacing: 0.4px;
    opacity: 0.55;
    text-transform: uppercase;
  }
  .label-slot .arrow { font-size: 10pt; opacity: 0.4; color: #000; }

  /* ── TITOLO + ESITO ── */
  .title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .doc-title {
    font-size: 13pt;
    font-weight: 700;
    color: #1a5fa8;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .esito-badge {
    display: inline-block;
    padding: 4px 16px;
    border-radius: 4px;
    font-size: 11pt;
    font-weight: 700;
    letter-spacing: 1px;
    background: ${esitoBg};
    color: ${esitoColor};
    border: 1.5px solid ${esitoColor};
  }

  /* ── LAYOUT A DUE COLONNE ── */
  .two-col {
    display: flex;
    gap: 14px;
    margin-bottom: 12px;
  }
  .col { flex: 1; }

  /* ── SEZIONE ── */
  .section-title {
    font-size: 7.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #888;
    margin-bottom: 5px;
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 3px;
  }

  /* ── TABELLA DATI DISPOSITIVO ── */
  table.data {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
  }
  table.data td {
    padding: 5px 8px;
    font-size: 9.5pt;
    border-bottom: 1px solid #f0f0f0;
  }
  table.data td:first-child { font-weight: 600; color: #444; width: 42%; }
  table.data td:last-child  { font-family: 'Courier New', monospace; font-size: 9pt; }
  table.data tr:nth-child(even) td { background: #f8f9fa; }

  /* ── TABELLE CHECKLIST ── */
  table.checks {
    width: 100%;
    border-collapse: collapse;
  }
  table.checks td {
    padding: 4px 8px;
    font-size: 9pt;
    border-bottom: 1px solid #f0f0f0;
  }
  table.checks tr:nth-child(even) td { background: #f8f9fa; }
  td.check {
    width: 28px;
    text-align: center;
    font-size: 11pt;
    font-weight: 700;
  }
  td.check.ok  { color: #1a7f37; }
  td.check.nok { color: #cf222e; }

  /* ── FIRMA ── */
  .firma-section {
    display: flex;
    gap: 40px;
    margin-top: 16px;
  }
  .firma-box {
    flex: 1;
    border-top: 1px solid #ccc;
    padding-top: 5px;
    font-size: 8pt;
    color: #888;
  }

  /* ── FOOTER ── */
  .footer {
    position: fixed;
    bottom: 10mm;
    left: 16mm;
    right: 16mm;
    border-top: 1px solid #e0e0e0;
    padding-top: 4px;
    display: flex;
    justify-content: space-between;
    font-size: 7pt;
    color: #aaa;
  }
</style>
</head>
<body>

  <div class="header">
    <div class="header-brand">GRUPPO <span>SIM</span> TEL</div>
    <div class="label-slot">
      <div class="arrow">&#8681;</div>
      <span>Applicare etichetta</span>
    </div>
    <div class="header-meta">
      <strong>Foglio di Collaudo Gateway</strong><br>
      Stampato il: ${new Date().toLocaleString('it-IT')}<br>
    </div>
  </div>

  <div class="title-row">
    <div class="doc-title">Verbale di Collaudo — Gateway Refurb</div>
    <div class="esito-badge">ESITO: ${esitoOk ? 'OK' : 'NOK'}</div>
  </div>

  <!-- Dati dispositivo + collaudo -->
  <div class="two-col">
    <div class="col">
      <div class="section-title">Dati dispositivo</div>
      <table class="data">
        <tr><td>SN (MAC eth0)</td><td>${row.sn       || '—'}</td></tr>
        <tr><td>Ext SN</td>       <td>${row.ext_sn   || '—'}</td></tr>
        <tr><td>ICCID SIM</td>    <td>${row.iccid    || '—'}</td></tr>
        <tr><td>Tipo gateway</td> <td>${row.sgw_type || '—'}</td></tr>
      </table>
    </div>
    <div class="col">
      <div class="section-title">Dati collaudo</div>
      <table class="data">
        <tr><td>Data test</td>            <td>${dataTest}</td></tr>
        <tr><td>Stampa etichetta</td>     <td>${dataStampa}</td></tr>
        <tr><td>Esito</td>                <td>${row.esito_test || '—'}</td></tr>
      </table>
    </div>
  </div>

  <!-- Checklist a due colonne -->
  <div class="two-col">
    <div class="col">
      <div class="section-title">1 — Electrical Check</div>
      <table class="checks">
        ${electricalRows}
      </table>
    </div>
    <div class="col">
      <div class="section-title">2 — Final Check</div>
      <table class="checks">
        ${finalRows}
      </table>
    </div>
  </div>

  <div class="firma-section">
    <div class="firma-box">Operatore collaudatore</div>
    <div class="firma-box">Responsabile controllo qualità</div>
  </div>

  <div class="footer">
    <span>Gruppo Sim Tel — Sistema Refurb Gateway</span>
    <span>${row.ext_sn} · ${row.iccid}</span>
    <span>Documento valido se presente firma di Responsabile Qualità</span>
  </div>

</body>
</html>`;
}

// ------------------------------------------------------------------------------
// INVIA FOGLIO COLLAUDO ALLA STAMPANTE A4 VIA CUPS
// ------------------------------------------------------------------------------
function printCollaudo(htmlContent) {
  return new Promise((resolve, reject) => {
    const ts      = Date.now();
    const tmpHtml = path.join(os.tmpdir(), `collaudo_${ts}.html`);
    const tmpPdf  = path.join(os.tmpdir(), `collaudo_${ts}.pdf`);

    // 1) Salva HTML
    fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

    // 2) Chromium headless: HTML → PDF
    const chromium = 'chromium';
    const cmdPdf = `${chromium} --headless --no-sandbox --disable-gpu `
                 + `--print-to-pdf="${tmpPdf}" `
                 + `--print-to-pdf-no-header `
                 + `"file://${tmpHtml}"`;

    exec(cmdPdf, (err, _stdout, stderr) => {
      if (err) {
        try { fs.unlinkSync(tmpHtml); } catch (_) {}
        return reject(new Error(`Chromium PDF error: ${stderr || err.message}`));
      }

      // 3) Invia PDF a CUPS
      const cmdLp = `lp -d ${CUPS_PRINTER} -o media=A4 "${tmpPdf}"`;
      exec(cmdLp, (err2, stdout2, stderr2) => {
        // Pulizia file temporanei
        try { fs.unlinkSync(tmpHtml); } catch (_) {}
        try { fs.unlinkSync(tmpPdf);  } catch (_) {}

        if (err2) {
          reject(new Error(`CUPS error: ${stderr2 || err2.message}`));
        } else {
          resolve(stdout2.trim());
        }
      });
    });
  });
}

// ------------------------------------------------------------------------------
// API — POST /api/verify
// Body: { ext_sn: "80001234" }
// Interroga il DB e restituisce i dati del dispositivo SENZA stampare nulla
// ------------------------------------------------------------------------------
app.post('/api/verify', async (req, res) => {
  const { ext_sn } = req.body;

  if (!ext_sn || !/^8000\d{4}$/.test(ext_sn)) {
    return res.status(400).json({ ok: false, error: 'Seriale non valido. Formato atteso: 8000XXXX' });
  }

  let client;
  try {
    client = await DB.connect();

    const result = await client.query(
      `SELECT id, sn, ext_sn, iccid, esito_test, sgw_type, data, data_stampa
       FROM device_tests
       WHERE ext_sn = $1
       ORDER BY data DESC
       LIMIT 1`,
      [ext_sn]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Nessun record trovato per il seriale ${ext_sn}` });
    }

    const row = result.rows[0];
    return res.json({ ok: true, data: row });

  } catch (err) {
    console.error('Errore verify:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/print
// Body: { ext_sn: "80001234", force: false }
// force=true → ristampa anche se già stampata in precedenza
// ------------------------------------------------------------------------------
app.post('/api/print', async (req, res) => {
  const { ext_sn, force = false } = req.body;

  if (!ext_sn || !/^8000\d{4}$/.test(ext_sn)) {
    return res.status(400).json({ ok: false, error: 'Seriale non valido. Formato atteso: 8000XXXX' });
  }

  let client;
  try {
    client = await DB.connect();

    // Cerca il record più recente per questo ext_sn
    const result = await client.query(
      `SELECT id, sn, ext_sn, iccid, esito_test, sgw_type, data, data_stampa
       FROM device_tests
       WHERE ext_sn = $1
       ORDER BY data DESC
       LIMIT 1`,
      [ext_sn]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Nessun record trovato per il seriale ${ext_sn}` });
    }

    const row = result.rows[0];

    // Controlla esito test
    if (row.esito_test !== 'OK') {
      return res.status(200).json({
        ok: false,
        esito: row.esito_test,
        error: `Il test per ${ext_sn} non è andato a buon fine (${row.esito_test}). Etichetta non stampata.`,
        data: row,
      });
    }

    // Già stampata in precedenza e non è una ristampa forzata
    if (row.data_stampa && !force) {
      return res.status(200).json({
        ok: false,
        already_printed: true,
        data_stampa: row.data_stampa,
        error: `Etichetta già stampata il ${new Date(row.data_stampa).toLocaleString('it-IT')}. Confermare la ristampa?`,
        data: row,
      });
    }

    // Stampa etichetta
    const zpl = buildZPL(row.sn, row.iccid, row.ext_sn);
    await printLabel(zpl);
    await printLabel(zpl);
    await printLabel(zpl);

    // Aggiorna data_stampa nel DB
    await client.query(
      `UPDATE device_tests SET data_stampa = NOW() WHERE id = $1`,
      [row.id]
    );

    return res.json({
      ok: true,
      reprint: !!row.data_stampa,
      message: row.data_stampa ? 'Ristampa effettuata con successo!' : 'Etichetta stampata con successo!',
      data: row,
    });

  } catch (err) {
    console.error('Errore:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/print-collaudo
// Body: { ext_sn: "80001234" }
// Genera HTML foglio A4 e lo stampa via CUPS
// ------------------------------------------------------------------------------
app.post('/api/print-collaudo', async (req, res) => {
  const { ext_sn } = req.body;

  if (!ext_sn || !/^8000\d{4}$/.test(ext_sn)) {
    return res.status(400).json({ ok: false, error: 'Seriale non valido. Formato atteso: 8000XXXX' });
  }

  let client;
  try {
    client = await DB.connect();

    const result = await client.query(
      `SELECT id, sn, ext_sn, iccid, esito_test, sgw_type, data, data_stampa
       FROM device_tests
       WHERE ext_sn = $1
       ORDER BY data DESC
       LIMIT 1`,
      [ext_sn]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Nessun record trovato per il seriale ${ext_sn}` });
    }

    const row = result.rows[0];
    const html = buildCollaudoHTML(row);
    const jobInfo = await printCollaudo(html);

    return res.json({
      ok: true,
      message: 'Foglio di collaudo inviato alla stampante A4.',
      job: jobInfo,
    });

  } catch (err) {
    console.error('Errore print-collaudo:', err.message);
    return res.status(500).json({ ok: false, error: `Errore stampa collaudo: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — GET /api/pdf-collaudo/:ext_sn
// Genera il PDF del foglio collaudo e lo restituisce come download
// ------------------------------------------------------------------------------
app.get('/api/pdf-collaudo/:ext_sn', async (req, res) => {
  const { ext_sn } = req.params;

  if (!ext_sn || !/^8000\d{4}$/.test(ext_sn)) {
    return res.status(400).json({ ok: false, error: 'Seriale non valido. Formato atteso: 8000XXXX' });
  }

  let client;
  try {
    client = await DB.connect();

    const result = await client.query(
      `SELECT id, sn, ext_sn, iccid, esito_test, sgw_type, data, data_stampa
       FROM device_tests
       WHERE ext_sn = $1
       ORDER BY data DESC
       LIMIT 1`,
      [ext_sn]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Nessun record trovato per il seriale ${ext_sn}` });
    }

    const row     = result.rows[0];
    const html    = buildCollaudoHTML(row);
    const ts      = Date.now();
    const tmpHtml = path.join(os.tmpdir(), `collaudo_${ts}.html`);
    const tmpPdf  = path.join(os.tmpdir(), `collaudo_${ts}.pdf`);

    fs.writeFileSync(tmpHtml, html, 'utf8');

    const cmdPdf = `chromium --headless --no-sandbox --disable-gpu `
                 + `--print-to-pdf="${tmpPdf}" `
                 + `--print-to-pdf-no-header `
                 + `"file://${tmpHtml}"`;

    exec(cmdPdf, (err, _stdout, stderr) => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}

      if (err) {
        return res.status(500).json({ ok: false, error: `Chromium PDF error: ${stderr || err.message}` });
      }

      const filename = `collaudo_${ext_sn}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const stream = fs.createReadStream(tmpPdf);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(tmpPdf); } catch (_) {}
      });
      stream.on('error', (streamErr) => {
        try { fs.unlinkSync(tmpPdf); } catch (_) {}
        res.status(500).json({ ok: false, error: streamErr.message });
      });
    });

  } catch (err) {
    console.error('Errore pdf-collaudo:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/report
// Body: { iccids: ["89390...", "89390...", ...] }
// Restituisce per ogni ICCID i dati trovati nel DB (o not_found)
// ------------------------------------------------------------------------------
app.post('/api/report', async (req, res) => {
  const { iccids } = req.body;

  if (!Array.isArray(iccids) || iccids.length === 0) {
    return res.status(400).json({ ok: false, error: 'Lista ICCID mancante o vuota.' });
  }

  // Normalizza: rimuove spazi e righe vuote, deduplica
  const cleaned = [...new Set(
    iccids.map(i => String(i).trim()).filter(i => i.length > 0)
  )];

  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: 'Nessun ICCID valido trovato.' });
  }

  let client;
  try {
    client = await DB.connect();

    // Query con ANY($1) per cercare tutti gli ICCID in un colpo solo
    const result = await client.query(
      `SELECT DISTINCT ON (iccid) iccid, sn, ext_sn, sgw_type, esito_test, data, data_stampa
       FROM device_tests
       WHERE iccid = ANY($1)
       ORDER BY iccid, data DESC`,
      [cleaned]
    );

    // Mappa iccid → row per lookup veloce
    const found = {};
    for (const row of result.rows) {
      found[row.iccid] = row;
    }

    // Costruisce la risposta mantenendo l'ordine originale dell'input
    const rows = cleaned.map(iccid => {
      if (found[iccid]) {
        return {
          iccid,
          sn:        found[iccid].sn,
          ext_sn:    found[iccid].ext_sn,
          sgw_type:  found[iccid].sgw_type,
          esito_test: found[iccid].esito_test,
          data:      found[iccid].data,
          data_stampa: found[iccid].data_stampa,
          found:     true,
        };
      }
      return { iccid, found: false };
    });

    return res.json({ ok: true, rows, total: cleaned.length, found: result.rows.length });

  } catch (err) {
    console.error('Errore report:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/outbox/create
// Body: { box_serial: "RBOX-1234", frs: ["FR12345", ...], tipo: "uscita_terzista" }
// Crea la scatola e associa i codici FR
// ------------------------------------------------------------------------------
app.post('/api/outbox/create', async (req, res) => {
  const { box_serial, frs, tipo } = req.body;

  // Validazione box_serial
  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }

  // Validazione tipo
  const validTypes = ['uscita_terzista', 'rientro_terzista', 'uscita_cliente'];
  const boxTipo = validTypes.includes(tipo) ? tipo : 'uscita_terzista';

  // Validazione lista FR
  if (!Array.isArray(frs) || frs.length === 0) {
    return res.status(400).json({ ok: false, error: 'Lista FR mancante o vuota.' });
  }

  // Normalizza: trim, deduplica mantenedo ordine, filtra vuoti
  const seen = new Set();
  const cleaned = [];
  for (const f of frs) {
    const val = String(f).trim().toUpperCase();
    if (val.length === 0) continue;
    if (!/^FR\d{5}$/.test(val)) {
      return res.status(400).json({ ok: false, error: `FR non valido: "${val}". Formato atteso: FR + 5 cifre (es. FR12345)` });
    }
    if (seen.has(val)) continue;
    seen.add(val);
    cleaned.push(val);
  }

  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: 'Nessun FR valido trovato.' });
  }

  let client;
  try {
    client = await DB.connect();

    // Controlla se il box esiste già
    const existing = await client.query(
      'SELECT id, stato FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );

    let boxId = existing.rows.length > 0 ? existing.rows[0].id : null;

    // Se il box esiste già ed è spedito, blocca l'aggiunta di FR
    if (boxId !== null && existing.rows[0].stato === 'spedito') {
      return res.status(409).json({
        ok: false,
        already_shipped: true,
        error: `Il box ${box_serial} è già stato spedito e non può essere modificato.`,
      });
    }

    // ── CONTROLLO CROSS-BOX: FR già assegnati ad un'altra box ──
    // Include stato per distinguere: rientrato (movibile) vs spedito/raccolto (bloccato)
    const conflicts = await client.query(
      `SELECT i.id, i.fr, i.stato, b.box_serial
       FROM outbound_box_items i
       JOIN outbound_boxes b ON i.box_id = b.id
       WHERE i.fr = ANY($1)
         AND ($2::integer IS NULL OR i.box_id != $2)`,
      [cleaned, boxId]
    );

    // Separa: FR rientrati (possono essere spostati) vs FR ancora in uso (bloccati)
    const movable   = conflicts.rows.filter(r => r.stato === 'rientrato');
    const blocked   = conflicts.rows.filter(r => r.stato !== 'rientrato');

    if (blocked.length > 0) {
      const conflictList = blocked
        .map(r => `${r.fr} → ${r.box_serial} (${r.stato})`)
        .join(', ');
      return res.status(409).json({
        ok: false,
        conflict: true,
        error: `Alcuni FR sono in uso in altre box e non sono ancora rientrati: ${conflictList}`,
        conflicts: blocked.map(r => ({ fr: r.fr, box_serial: r.box_serial, stato: r.stato })),
      });
    }

    const movableFrs     = new Set(movable.map(r => r.fr));
    const movableItemIds = movable.map(r => r.id);

    // Crea il box se nuovo
    const isNewBox = (boxId === null);
    if (isNewBox) {
      const insertBox = await client.query(
        'INSERT INTO outbound_boxes (box_serial, tipo) VALUES ($1, $2) RETURNING id',
        [box_serial, boxTipo]
      );
      boxId = insertBox.rows[0].id;
    }

    // Controlla quali FR sono già presenti in questo box (duplicati interni)
    const alreadyInBox = await client.query(
      'SELECT fr FROM outbound_box_items WHERE box_id = $1 AND fr = ANY($2)',
      [boxId, cleaned]
    );
    const existingFrs = new Set(alreadyInBox.rows.map(r => r.fr));

    // FR da spostare: rientrati in altre box e non già in questa box
    const toMove = movable.filter(r => !existingFrs.has(r.fr));

    // FR da inserire come nuovi: non in nessuna box, non già in questa
    const toInsert = cleaned.filter(f => !movableFrs.has(f) && !existingFrs.has(f));

    // Sposta i FR rientrati nella nuova box (reset stato a 'raccolto')
    if (toMove.length > 0) {
      const moveIds = toMove.map(r => r.id);
      await client.query(
        `UPDATE outbound_box_items
         SET box_id = $1, stato = 'raccolto', data_rientro = NULL
         WHERE id = ANY($2)`,
        [boxId, moveIds]
      );
    }

    // Inserisci i nuovi FR
    for (const fr of toInsert) {
      await client.query(
        'INSERT INTO outbound_box_items (box_id, fr) VALUES ($1, $2)',
        [boxId, fr]
      );
    }

    const addedCount  = toMove.length + toInsert.length;
    const skippedCount = cleaned.length - addedCount;

    if (addedCount === 0) {
      return res.status(200).json({
        ok: false,
        already_exists: true,
        error: `Tutti i ${cleaned.length} FR sono già associati al box ${box_serial}.`,
        count: existingFrs.size,
      });
    }

    // Conta totale FR nella box
    const totalItems = await client.query(
      'SELECT COUNT(*) as cnt FROM outbound_box_items WHERE box_id = $1',
      [boxId]
    );

    // Messaggio descrittivo
    let msg;
    if (isNewBox) {
      msg = `Box ${box_serial} creato con ${addedCount} FR associati`;
    } else {
      msg = `Aggiunti ${addedCount} FR al box ${box_serial} (totale: ${totalItems.rows[0].cnt})`;
    }
    if (toMove.length > 0 && toInsert.length > 0) {
      msg += ` (${toMove.length} rientrati da altre box, ${toInsert.length} nuovi).`;
    } else if (toMove.length > 0) {
      msg += ` (${toMove.length} rientrati da altre box).`;
    } else if (toInsert.length > 0 && !isNewBox) {
      msg += ` (${toInsert.length} nuovi).`;
    } else {
      msg += '.';
    }

    return res.json({
      ok: true,
      message: msg,
      added: addedCount,
      moved: toMove.length,
      inserted: toInsert.length,
      skipped: skippedCount,
      total: parseInt(totalItems.rows[0].cnt),
      box_serial,
    });

  } catch (err) {
    console.error('Errore outbox/create:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — GET /api/outbox/next-serial
// Suggerisce il primo seriale box consecutivo disponibile
// ------------------------------------------------------------------------------
app.get('/api/outbox/next-serial', async (req, res) => {
  let client;
  try {
    client = await DB.connect();

    // Trova il numero massimo usato in qualsiasi formato (RBOX-NNNN o RBOX-OUT-NNNN)
    const result = await client.query(`
      SELECT COALESCE(
        MAX(CAST(SUBSTRING(box_serial FROM 'RBOX-(?:OUT-)?(\\d+)') AS INTEGER)),
        0
      ) AS max_num
      FROM outbound_boxes
      WHERE box_serial ~ '^RBOX-(?:OUT-)?\\d+$'
    `);

    const nextNum = result.rows[0].max_num + 1;
    const padded = String(nextNum).padStart(4, '0');
    const nextSerial = `RBOX-${padded}`;

    return res.json({ ok: true, next_serial: nextSerial, next_num: padded });

  } catch (err) {
    console.error('Errore outbox/next-serial:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/outbox/print-label
// Body: { box_serial: "RBOX-OUT-1234", copies: 2 }
// Stampa N copie dell'etichetta box (50,8x25,4mm) sulla Zebra con QR code + testo
// ------------------------------------------------------------------------------
app.post('/api/outbox/print-label', async (req, res) => {
  const { box_serial, copies = 1 } = req.body;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }

  const numCopies = Math.max(1, Math.min(parseInt(copies) || 1, 50));

  try {
    const zpl = buildBoxLabelZPL(box_serial);
    for (let i = 0; i < numCopies; i++) {
      await printLabel(zpl);
    }
    return res.json({
      ok: true,
      message: `${numCopies} etichett${numCopies === 1 ? 'a' : 'e'} box stampat${numCopies === 1 ? 'a' : 'e'} per ${box_serial}.`,
      copies: numCopies,
    });
  } catch (err) {
    console.error('Errore outbox/print-label:', err.message);
    return res.status(500).json({ ok: false, error: `Errore stampa etichetta: ${err.message}` });
  }
});

// ------------------------------------------------------------------------------
// API — GET /api/outbox/dashboard
// Restituisce una panoramica dello stato di spedizione/rientro
// NOTA: deve essere prima di /:box_serial per evitare conflitto di routing
// ------------------------------------------------------------------------------
app.get('/api/outbox/dashboard', async (req, res) => {
  let client;
  try {
    client = await DB.connect();

    const summary = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE i.stato = 'spedito' AND b.tipo = 'uscita_terzista') AS in_lavorazione,
        COUNT(*) FILTER (WHERE i.stato = 'rientrato') AS rientrati_pending,
        COUNT(*) FILTER (WHERE i.stato = 'spedito' AND b.tipo = 'uscita_cliente') AS spediti_cliente
      FROM outbound_box_items i
      JOIN outbound_boxes b ON i.box_id = b.id
    `);

    const boxes = await client.query(`
      SELECT
        b.id, b.box_serial, b.tipo, b.stato, b.data_creazione,
        b.data_spedizione, b.ddt_uscita,
        COUNT(i.id) AS fr_totali,
        COUNT(i.id) FILTER (WHERE i.stato = 'spedito') AS fr_spediti,
        COUNT(i.id) FILTER (WHERE i.stato = 'rientrato') AS fr_rientrati,
        COUNT(i.id) FILTER (WHERE i.stato = 'raccolto') AS fr_raccolti
      FROM outbound_boxes b
      LEFT JOIN outbound_box_items i ON b.id = i.box_id
      GROUP BY b.id
      ORDER BY b.data_creazione DESC
    `);

    return res.json({
      ok: true,
      summary: {
        in_lavorazione: parseInt(summary.rows[0].in_lavorazione) || 0,
        rientrati_pending: parseInt(summary.rows[0].rientrati_pending) || 0,
        spediti_cliente: parseInt(summary.rows[0].spediti_cliente) || 0,
      },
      boxes: boxes.rows.map(r => ({
        id: r.id, box_serial: r.box_serial, tipo: r.tipo, stato: r.stato,
        data_creazione: r.data_creazione, data_spedizione: r.data_spedizione,
        ddt_uscita: r.ddt_uscita,
        fr_totali: parseInt(r.fr_totali) || 0,
        fr_spediti: parseInt(r.fr_spediti) || 0,
        fr_rientrati: parseInt(r.fr_rientrati) || 0,
        fr_raccolti: parseInt(r.fr_raccolti) || 0,
      })),
    });

  } catch (err) {
    console.error('Errore outbox/dashboard:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — GET /api/outbox/:box_serial
// Restituisce tutti i FR associati al box specificato
// ------------------------------------------------------------------------------
app.get('/api/outbox/:box_serial', async (req, res) => {
  const { box_serial } = req.params;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, box_serial, tipo, stato, data_creazione, data_spedizione, ddt_uscita FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );

    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }

    const box = boxResult.rows[0];

    const itemsResult = await client.query(
      `SELECT id, fr, stato, data_inserimento, data_rientro
       FROM outbound_box_items
       WHERE box_id = $1
       ORDER BY id ASC`,
      [box.id]
    );

    return res.json({
      ok: true,
      box: {
        id: box.id,
        box_serial: box.box_serial,
        tipo: box.tipo,
        stato: box.stato,
        data_creazione: box.data_creazione,
        data_spedizione: box.data_spedizione,
        ddt_uscita: box.ddt_uscita,
      },
      items: itemsResult.rows.map(r => ({
        fr: r.fr,
        stato: r.stato,
        data_inserimento: r.data_inserimento,
        data_rientro: r.data_rientro,
      })),
      count: itemsResult.rows.length,
    });

  } catch (err) {
    console.error('Errore outbox/get:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — GET /api/outbox/:box_serial/export/:format
// Export FR del box in CSV o TXT (download diretto)
// ------------------------------------------------------------------------------
app.get('/api/outbox/:box_serial/export/:format', async (req, res) => {
  const { box_serial, format } = req.params;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido.' });
  }

  if (!['csv', 'txt'].includes(format)) {
    return res.status(400).json({ ok: false, error: 'Formato non supportato. Usa csv o txt.' });
  }

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, box_serial, tipo, stato, data_creazione, data_spedizione, ddt_uscita FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );

    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }

    const box = boxResult.rows[0];

    const itemsResult = await client.query(
      'SELECT fr FROM outbound_box_items WHERE box_id = $1 ORDER BY id ASC',
      [box.id]
    );

    const frs = itemsResult.rows.map(r => r.fr);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    if (format === 'csv') {
      const header = 'box_serial,fr,data_esportazione';
      const lines = frs.map(fr => `${box_serial},${fr},${new Date().toISOString()}`);
      const content = [header, ...lines].join('\r\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${box_serial}_${dateStr}.csv"`);
      return res.send(content);

    } else {
      // TXT — lista semplice con intestazione
      const lines = [
        `Box: ${box_serial}`,
        `Data creazione: ${new Date(box.data_creazione).toLocaleString('it-IT')}`,
        `Totale FR: ${frs.length}`,
        `${'-'.repeat(40)}`,
        ...frs,
      ];
      const content = lines.join('\r\n');

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${box_serial}_${dateStr}.txt"`);
      return res.send(content);
    }

  } catch (err) {
    console.error('Errore outbox/export:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — GET /api/outbox/:box_serial/pdf
// Genera PDF della lista FR del box e lo restituisce come download
// ------------------------------------------------------------------------------
app.get('/api/outbox/:box_serial/pdf', async (req, res) => {
  const { box_serial } = req.params;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido.' });
  }

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, box_serial, tipo, stato, data_creazione, data_spedizione, ddt_uscita FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );

    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }

    const box = boxResult.rows[0];

    const itemsResult = await client.query(
      'SELECT fr, data_inserimento FROM outbound_box_items WHERE box_id = $1 ORDER BY id ASC',
      [box.id]
    );

    const frs = itemsResult.rows;
    const dataCreazione = new Date(box.data_creazione).toLocaleString('it-IT');

    const rowsHtml = frs.map((r, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td class="fr">${r.fr}</td>
        <td class="date">${new Date(r.data_inserimento).toLocaleString('it-IT')}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    padding: 18mm 20mm 16mm 20mm;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 2px solid #1a5fa8;
    padding-bottom: 10px;
    margin-bottom: 16px;
  }
  .header-brand { font-size: 18pt; font-weight: 700; color: #1a5fa8; letter-spacing: -0.5px; }
  .header-brand span { color: #e05c00; }
  .header-meta { text-align: right; font-size: 8.5pt; color: #555; line-height: 1.6; }
  .header-meta strong { font-size: 10pt; color: #1a1a1a; }
  .doc-title {
    font-size: 14pt;
    font-weight: 700;
    color: #1a5fa8;
    text-transform: uppercase;
    margin-bottom: 14px;
    letter-spacing: 0.4px;
  }
  .info-box {
    background: #f0f5fa;
    border: 1px solid #d0dbe8;
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 10pt;
  }
  .info-box .row { display: flex; gap: 8px; margin-bottom: 4px; }
  .info-box .row:last-child { margin-bottom: 0; }
  .info-box .k { font-weight: 600; color: #444; min-width: 140px; }
  .info-box .v { font-family: 'Courier New', monospace; color: #1a1a1a; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4px;
  }
  thead th {
    background: #1a5fa8;
    color: #fff;
    padding: 8px 12px;
    text-align: left;
    font-size: 9pt;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  tbody td {
    padding: 7px 12px;
    font-size: 10pt;
    border-bottom: 1px solid #e0e0e0;
  }
  tbody tr:nth-child(even) td { background: #f8f9fa; }
  td.num { color: #888; width: 40px; text-align: center; font-size: 9pt; }
  td.fr { font-family: 'Courier New', monospace; font-weight: 600; font-size: 11pt; }
  td.date { font-size: 9pt; color: #666; white-space: nowrap; }
  .footer {
    position: fixed;
    bottom: 10mm;
    left: 20mm;
    right: 20mm;
    border-top: 1px solid #e0e0e0;
    padding-top: 5px;
    font-size: 7.5pt;
    color: #aaa;
    display: flex;
    justify-content: space-between;
  }
</style>
</head>
<body>

  <div class="header">
    <div class="header-brand">GRUPPO <span>SIM</span> TEL</div>
    <div class="header-meta">
      <strong>Distinta Uscita Gateway</strong><br>
      Generato il: ${new Date().toLocaleString('it-IT')}
    </div>
  </div>

  <div class="doc-title">Distinta Box — Uscita verso terzista</div>

  <div class="info-box">
    <div class="row"><span class="k">Seriale box:</span><span class="v">${box_serial}</span></div>
    <div class="row"><span class="k">Data creazione:</span><span class="v">${dataCreazione}</span></div>
    <div class="row"><span class="k">Totale FR:</span><span class="v">${frs.length}</span></div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Codice FR</th>
        <th>Data inserimento</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <div class="footer">
    <span>Gruppo Sim Tel — Sistema Refurb Gateway</span>
    <span>${box_serial} · ${frs.length} FR</span>
  </div>

</body>
</html>`;

    const ts      = Date.now();
    const tmpHtml = path.join(os.tmpdir(), `outbox_${ts}.html`);
    const tmpPdf  = path.join(os.tmpdir(), `outbox_${ts}.pdf`);

    fs.writeFileSync(tmpHtml, html, 'utf8');

    const cmdPdf = `chromium --headless --no-sandbox --disable-gpu `
                 + `--print-to-pdf="${tmpPdf}" `
                 + `--print-to-pdf-no-header `
                 + `"file://${tmpHtml}"`;

    exec(cmdPdf, (err, _stdout, stderr) => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}

      if (err) {
        return res.status(500).json({ ok: false, error: `Chromium PDF error: ${stderr || err.message}` });
      }

      const filename = `distinta_${box_serial}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const stream = fs.createReadStream(tmpPdf);
      stream.pipe(res);
      stream.on('end', () => {
        try { fs.unlinkSync(tmpPdf); } catch (_) {}
      });
      stream.on('error', (streamErr) => {
        try { fs.unlinkSync(tmpPdf); } catch (_) {}
        res.status(500).json({ ok: false, error: streamErr.message });
      });
    });

  } catch (err) {
    console.error('Errore outbox/pdf:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/outbox/ship
// Body: { box_serial: "RBOX-1234", ddt: "DDT-2026-001" }
// Marca la box come spedita e tutti i suoi FR come 'spedito'
// ------------------------------------------------------------------------------
app.post('/api/outbox/ship', async (req, res) => {
  const { box_serial, ddt } = req.body;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }

  const ddtNorm = ddt ? String(ddt).trim() : null;

  let client;
  try {
    client = await DB.connect();

    // Verifica che il box esista e sia in stato 'creato'
    const boxResult = await client.query(
      'SELECT id, stato, tipo FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );

    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }

    const box = boxResult.rows[0];

    if (box.stato === 'spedito') {
      return res.status(200).json({
        ok: false,
        already_shipped: true,
        error: `Box ${box_serial} già spedita${box.data_spedizione ? ' il ' + new Date(box.data_spedizione).toLocaleString('it-IT') : ''}.`,
      });
    }

    // Aggiorna la box
    await client.query(
      `UPDATE outbound_boxes
       SET stato = 'spedito', data_spedizione = NOW(), ddt_uscita = $2
       WHERE id = $1`,
      [box.id, ddtNorm]
    );

    // Aggiorna tutti gli FR della box
    const itemsResult = await client.query(
      `UPDATE outbound_box_items
       SET stato = 'spedito'
       WHERE box_id = $1
       RETURNING fr`,
      [box.id]
    );

    return res.json({
      ok: true,
      message: `Box ${box_serial} spedita${ddtNorm ? ' (DDT: ' + ddtNorm + ')' : ' (senza DDT)'}. ${itemsResult.rows.length} FR marcati come spediti.`,
      ddt: ddtNorm || '',
      fr_count: itemsResult.rows.length,
      box_serial,
    });

  } catch (err) {
    console.error('Errore outbox/ship:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — POST /api/outbox/return
// Body: { frs: ["FR12345", "FR12346"], box_rientro: "RBOX-0050" (opzionale) }
// Registra il rientro di uno o più FR dalla lavorazione terzista
// ------------------------------------------------------------------------------
app.post('/api/outbox/return', async (req, res) => {
  const { frs, box_rientro } = req.body;

  if (!Array.isArray(frs) || frs.length === 0) {
    return res.status(400).json({ ok: false, error: 'Lista FR mancante o vuota.' });
  }

  // Normalizza FR
  const seen = new Set();
  const cleaned = [];
  for (const f of frs) {
    const val = String(f).trim().toUpperCase();
    if (val.length === 0) continue;
    if (!/^FR\d{5}$/.test(val)) {
      return res.status(400).json({ ok: false, error: `FR non valido: "${val}". Formato atteso: FR + 5 cifre.` });
    }
    if (seen.has(val)) continue;
    seen.add(val);
    cleaned.push(val);
  }

  if (cleaned.length === 0) {
    return res.status(400).json({ ok: false, error: 'Nessun FR valido trovato.' });
  }

  // Normalizza box_rientro (opzionale)
  const boxRientro = box_rientro ? String(box_rientro).trim().toUpperCase() : null;
  if (boxRientro && !/^RBOX-(OUT-)?\d+$/.test(boxRientro)) {
    return res.status(400).json({ ok: false, error: 'Seriale box rientro non valido. Formato atteso: RBOX-NNNN' });
  }

  let client;
  try {
    client = await DB.connect();

    const returned = [];
    const warnings = [];
    const affectedBoxIds = new Set();
    const boxIdToSerial = new Map();

    for (const fr of cleaned) {
      // Cerca l'FR in outbound_box_items con stato 'spedito'
      const itemResult = await client.query(
        `SELECT i.id, i.box_id, b.box_serial, b.ddt_uscita, i.data_rientro
         FROM outbound_box_items i
         JOIN outbound_boxes b ON i.box_id = b.id
         WHERE i.fr = $1 AND i.stato = 'spedito'
         ORDER BY i.id DESC
         LIMIT 1`,
        [fr]
      );

      if (itemResult.rows.length === 0) {
        // Controlla se è già rientrato
        const alreadyReturned = await client.query(
          `SELECT i.data_rientro, b.box_serial
           FROM outbound_box_items i
           JOIN outbound_boxes b ON i.box_id = b.id
           WHERE i.fr = $1 AND i.stato = 'rientrato'
           LIMIT 1`,
          [fr]
        );

        if (alreadyReturned.rows.length > 0) {
          const dataRientro = new Date(alreadyReturned.rows[0].data_rientro).toLocaleString('it-IT');
          warnings.push({ fr, reason: `Già rientrato il ${dataRientro} (box ${alreadyReturned.rows[0].box_serial})` });
        } else {
          // Controlla se esiste ma è ancora 'raccolto' (non spedito)
          const notShipped = await client.query(
            `SELECT b.box_serial
             FROM outbound_box_items i
             JOIN outbound_boxes b ON i.box_id = b.id
             WHERE i.fr = $1 AND i.stato = 'raccolto'
             LIMIT 1`,
            [fr]
          );

          if (notShipped.rows.length > 0) {
            warnings.push({ fr, reason: `FR in box ${notShipped.rows[0].box_serial} ma non ancora spedito` });
          } else {
            warnings.push({ fr, reason: 'FR non trovato in nessuna box spedita' });
          }
        }
        continue;
      }

      const item = itemResult.rows[0];

      // Aggiorna lo stato dell'FR
      await client.query(
        `UPDATE outbound_box_items SET stato = 'rientrato', data_rientro = NOW() WHERE id = $1`,
        [item.id]
      );

      // Inserisci record di audit in rientri
      await client.query(
        `INSERT INTO rientri (fr, box_rientro, outbound_item_id) VALUES ($1, $2, $3)`,
        [fr, boxRientro, item.id]
      );

      returned.push({
        fr,
        original_box: item.box_serial,
        ddt: item.ddt_uscita || '—',
      });
      affectedBoxIds.add(item.box_id);
      boxIdToSerial.set(item.box_id, item.box_serial);
    }

    // Aggiorna stato box: se tutti gli FR di un box sono rientrati -> 'completato'
    const completed_boxes = [];
    for (const bid of affectedBoxIds) {
      const upd = await client.query(
        `UPDATE outbound_boxes SET stato = 'completato'
         WHERE id = $1 AND stato = 'spedito'
           AND NOT EXISTS (SELECT 1 FROM outbound_box_items WHERE box_id = $1 AND stato <> 'rientrato')`,
        [bid]
      );
      if (upd.rowCount > 0) completed_boxes.push(boxIdToSerial.get(bid));
    }

    return res.json({
      ok: true,
      returned_count: returned.length,
      warnings_count: warnings.length,
      returned,
      warnings,
      completed_boxes,
      box_rientro: boxRientro,
    });

  } catch (err) {
    console.error('Errore outbox/return:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — DELETE /api/outbox/:box_serial/items/:fr
// Rimuove un singolo FR da un box (solo se box in stato 'creato')
// ------------------------------------------------------------------------------
app.delete('/api/outbox/:box_serial/items/:fr', async (req, res) => {
  const { box_serial, fr } = req.params;
  const frNorm = String(fr).trim().toUpperCase();

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }
  if (!frNorm || !/^FR\d{5}$/.test(frNorm)) {
    return res.status(400).json({ ok: false, error: 'FR non valido. Formato atteso: FR + 5 cifre (es. FR12345)' });
  }

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, stato FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );
    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }
    const box = boxResult.rows[0];
    if (box.stato === 'spedito') {
      return res.status(409).json({ ok: false, error: `Box ${box_serial} già spedito: impossibile rimuovere FR.` });
    }

    const delResult = await client.query(
      'DELETE FROM outbound_box_items WHERE box_id = $1 AND fr = $2 RETURNING id',
      [box.id, frNorm]
    );
    if (delResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `FR ${frNorm} non trovato nel box ${box_serial}.` });
    }

    const totalItems = await client.query(
      'SELECT COUNT(*) as cnt FROM outbound_box_items WHERE box_id = $1',
      [box.id]
    );

    return res.json({
      ok: true,
      message: `FR ${frNorm} rimosso dal box ${box_serial}.`,
      fr: frNorm,
      box_serial,
      remaining: parseInt(totalItems.rows[0].cnt),
    });

  } catch (err) {
    console.error('Errore outbox/delete-item:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — DELETE /api/outbox/:box_serial
// Elimina un'intera box (solo se in stato 'creato'). Il CASCADE rimuove i FR.
// ------------------------------------------------------------------------------
app.delete('/api/outbox/:box_serial', async (req, res) => {
  const { box_serial } = req.params;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, stato FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );
    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }
    const box = boxResult.rows[0];
    if (box.stato === 'spedito') {
      return res.status(409).json({ ok: false, error: `Box ${box_serial} già spedito: impossibile eliminarlo.` });
    }

    // Conta FR prima dell'eliminazione (per il messaggio)
    const countResult = await client.query(
      'SELECT COUNT(*) as cnt FROM outbound_box_items WHERE box_id = $1',
      [box.id]
    );
    const frCount = parseInt(countResult.rows[0].cnt);

    // Elimina il box (CASCADE rimuove gli items; per box 'creato' non ci sono record in rientri)
    await client.query('DELETE FROM outbound_boxes WHERE id = $1', [box.id]);

    return res.json({
      ok: true,
      message: `Box ${box_serial} eliminato. ${frCount} FR rimossi.`,
      box_serial,
      fr_removed: frCount,
    });

  } catch (err) {
    console.error('Errore outbox/delete-box:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — PATCH /api/outbox/:box_serial
// Modifica il tipo di un box (solo se in stato 'creato'). Body: { tipo }
// ------------------------------------------------------------------------------
app.patch('/api/outbox/:box_serial', async (req, res) => {
  const { box_serial } = req.params;
  const { tipo } = req.body;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }
  const validTypes = ['uscita_terzista', 'rientro_terzista', 'uscita_cliente'];
  if (!validTypes.includes(tipo)) {
    return res.status(400).json({ ok: false, error: 'Tipo box non valido.' });
  }

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, stato FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );
    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }
    const box = boxResult.rows[0];
    if (box.stato === 'spedito') {
      return res.status(409).json({ ok: false, error: `Box ${box_serial} già spedito: impossibile modificarlo.` });
    }

    await client.query(
      'UPDATE outbound_boxes SET tipo = $2 WHERE id = $1',
      [box.id, tipo]
    );

    return res.json({
      ok: true,
      message: `Tipo del box ${box_serial} aggiornato.`,
      box_serial,
      tipo,
    });

  } catch (err) {
    console.error('Errore outbox/patch-tipo:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// API — PATCH /api/outbox/:box_serial/ddt
// Imposta/modifica il DDT di uscita di un box (in qualsiasi stato).
// Body: { ddt: "..." } — ddt può essere vuoto per rimuoverlo.
// ------------------------------------------------------------------------------
app.patch('/api/outbox/:box_serial/ddt', async (req, res) => {
  const { box_serial } = req.params;
  const { ddt } = req.body;

  if (!box_serial || !/^RBOX-(OUT-)?\d+$/.test(box_serial)) {
    return res.status(400).json({ ok: false, error: 'Seriale box non valido. Formato atteso: RBOX-NNNN' });
  }
  const ddtNorm = ddt ? String(ddt).trim() : null;

  let client;
  try {
    client = await DB.connect();

    const boxResult = await client.query(
      'SELECT id, stato FROM outbound_boxes WHERE box_serial = $1',
      [box_serial]
    );
    if (boxResult.rows.length === 0) {
      return res.status(404).json({ ok: false, error: `Box ${box_serial} non trovato.` });
    }

    await client.query(
      'UPDATE outbound_boxes SET ddt_uscita = $2 WHERE id = $1',
      [boxResult.rows[0].id, ddtNorm]
    );

    return res.json({
      ok: true,
      message: `DDT del box ${box_serial} aggiornato.`,
      box_serial,
      ddt_uscita: ddtNorm || '',
    });

  } catch (err) {
    console.error('Errore outbox/patch-ddt:', err.message);
    return res.status(500).json({ ok: false, error: `Errore interno: ${err.message}` });
  } finally {
    if (client) client.release();
  }
});

// ------------------------------------------------------------------------------
// AVVIO
// ------------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✓ Label app in ascolto su http://0.0.0.0:${PORT}`);
  console.log(`  DB:      10.11.12.8:5432/device_db`);
  console.log(`  Zebra:   ${ZEBRA_IP}:${ZEBRA_PORT}`);
});
