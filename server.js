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
// AVVIO
// ------------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`✓ Label app in ascolto su http://0.0.0.0:${PORT}`);
  console.log(`  DB:      10.11.12.8:5432/device_db`);
  console.log(`  Zebra:   ${ZEBRA_IP}:${ZEBRA_PORT}`);
});
