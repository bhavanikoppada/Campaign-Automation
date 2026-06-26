// ─────────────────────────────────────────────────────────────────────────────
//  NxtWave Campaign Manager — server.js
//  • Serves the dashboard UI (public/index.html)
//  • REST API for campaign list, send-test, approve, reject
//  • Background poller fires N8N webhooks at test_time
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const axios      = require('axios');
const path       = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  sheetId       : process.env.SHEET_ID          || '166dxm8lGoJu2L83JfYc11G5Y8cZZZeMMbSHpsUyV1kI',
  sheetName     : process.env.SHEET_NAME        || 'Sheet1',
  // Production webhook: works 24/7 once the workflow is Active. Runs show in N8N "Executions".
  n8nWebhook    : process.env.N8N_WEBHOOK       || 'https://academyss.app.n8n.cloud/webhook/scheduled-campaign-v1',
  // Test webhook: animates the canvas live, but only fires once after you click "Execute workflow".
  n8nWebhookTest: process.env.N8N_WEBHOOK_TEST  || 'https://academyss.app.n8n.cloud/webhook-test/scheduled-campaign-v1',
  pollMs        : parseInt(process.env.POLL_MS  || '60000'),
  port          : parseInt(process.env.PORT     || '3000'),
};

// Pick the webhook URL by mode. mode='test' → test webhook (canvas animates,
// requires clicking "Execute workflow" in N8N first). Anything else → production.
function webhookFor(mode) {
  return mode === 'test' ? CFG.n8nWebhookTest : CFG.n8nWebhook;
}

// ─── Google Sheets ─────────────────────────────────────────────────────────────
function buildAuth() {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes });
  }
  // Fallback for local dev: a service account key file on disk.
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    return new google.auth.GoogleAuth({ keyFile, scopes });
  }
  throw new Error('Set GOOGLE_SERVICE_ACCOUNT_JSON (inline) or GOOGLE_APPLICATION_CREDENTIALS (file path)');
}

let _hdr = null; // cached header row

async function sheetsClient() {
  const client = await buildAuth().getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function headers(sheets) {
  if (_hdr) return _hdr;
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: CFG.sheetId,
    range: `${CFG.sheetName}!1:1`,
  });
  _hdr = r.data.values?.[0] || [];
  return _hdr;
}

// Read all campaign rows
async function getCampaigns() {
  const s = await sheetsClient();
  const r = await s.spreadsheets.values.get({
    spreadsheetId: CFG.sheetId,
    range: CFG.sheetName,
  });
  const [hdrs, ...rows] = r.data.values || [[]];
  _hdr = hdrs;
  return rows
    .map((row, i) => {
      const obj = { row_number: i + 2 };
      hdrs.forEach((h, j) => { obj[h] = (row[j] ?? ''); });
      return obj;
    })
    .filter(r => r.subject || r.channel);
}

// Column index → letter (1=A, 27=AA …)
function colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(64 + ((n - 1) % 26 + 1)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Patch specific columns of a row without touching others
async function patchRow(rowNumber, updates) {
  const s = await sheetsClient();
  await headers(s);
  const cur = await s.spreadsheets.values.get({
    spreadsheetId: CFG.sheetId,
    range: `${CFG.sheetName}!A${rowNumber}:ZZ${rowNumber}`,
  });
  const row = [...(cur.data.values?.[0] || [])];
  while (row.length < _hdr.length) row.push('');

  for (const [key, val] of Object.entries(updates)) {
    let idx = _hdr.indexOf(key);
    if (idx === -1) {
      _hdr.push(key);
      await s.spreadsheets.values.update({
        spreadsheetId: CFG.sheetId,
        range: `${CFG.sheetName}!${colLetter(_hdr.length)}1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[key]] },
      });
      row.push(val);
    } else {
      row[idx] = val;
    }
  }
  await s.spreadsheets.values.update({
    spreadsheetId: CFG.sheetId,
    range: `${CFG.sheetName}!A${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/health', (_, res) =>
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    n8nWebhook: CFG.n8nWebhook,
    n8nWebhookTest: CFG.n8nWebhookTest,
    sheetId: CFG.sheetId,
  })
);

// GET all campaigns
app.get('/api/campaigns', async (req, res) => {
  try {
    const data = await getCampaigns();
    res.json({ ok: true, data, count: data.length });
  } catch (e) {
    console.error('[/api/campaigns]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST fire N8N webhook for this specific campaign.
// Optional ?mode=test (or body { "mode": "test" }) hits the test webhook so the
// N8N canvas animates — you must click "Execute workflow" in N8N right before.
app.post('/api/campaigns/:row/send-test', async (req, res) => {
  const row = parseInt(req.params.row);
  if (isNaN(row)) return res.status(400).json({ ok: false, error: 'Invalid row number' });
  const mode = req.query.mode || req.body?.mode;
  const url = webhookFor(mode);
  try {
    await axios.post(url, { row_number: row }, { timeout: 10_000 });
    res.json({ ok: true, message: 'Triggered successfully!', mode: mode === 'test' ? 'test' : 'production', webhook: url });
  } catch (e) {
    const status = e.response?.status;
    const hint = status === 404 && mode === 'test'
      ? 'Test webhook not registered. In N8N click "Execute workflow" first, then retry (test mode fires once per click).'
      : undefined;
    res.status(500).json({ ok: false, error: e.message, hint });
  }
});

// POST generic trigger — body: { "row_number": 177, "mode": "test" | "production" }
app.post('/api/trigger', async (req, res) => {
  const rowNumber = parseInt(req.body?.row_number);
  if (isNaN(rowNumber)) return res.status(400).json({ ok: false, error: 'row_number is required' });
  const mode = req.body?.mode;
  const url = webhookFor(mode);
  try {
    const r = await axios.post(url, { row_number: rowNumber }, { timeout: 10_000 });
    res.json({ ok: true, mode: mode === 'test' ? 'test' : 'production', webhook: url, n8n: r.data });
  } catch (e) {
    const status = e.response?.status;
    const hint = status === 404 && mode === 'test'
      ? 'Test webhook not registered. In N8N click "Execute workflow" first, then retry (test mode fires once per click).'
      : undefined;
    res.status(500).json({ ok: false, error: e.message, hint });
  }
});

// POST approve — calls N8N resumeUrl stored in "Resume URL" column
app.post('/api/campaigns/:row/approve', async (req, res) => {
  const row = parseInt(req.params.row);
  try {
    const all = await getCampaigns();
    const c = all.find(x => x.row_number === row);
    if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });

    const url = c['Resume URL'];
    if (!url) {
      return res.status(400).json({
        ok: false,
        error: 'Resume URL not found in sheet. See setup: N8N must write $execution.resumeUrl to the "Resume URL" column.',
      });
    }
    await axios.get(`${url}&action=approve`, { timeout: 10_000 });
    res.json({ ok: true, message: 'Campaign approved!' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST reject / needs modification
app.post('/api/campaigns/:row/reject', async (req, res) => {
  const row = parseInt(req.params.row);
  try {
    const all = await getCampaigns();
    const c = all.find(x => x.row_number === row);
    if (!c) return res.status(404).json({ ok: false, error: 'Campaign not found' });

    const url = c['Resume URL'];
    if (!url) return res.status(400).json({ ok: false, error: 'Resume URL not found in sheet.' });

    await axios.get(`${url}&action=modify`, { timeout: 10_000 });
    res.json({ ok: true, message: 'Marked as Needs Modification.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Background Poller ─────────────────────────────────────────────────────────
function parseTime(s) {
  if (!s) return null;
  try { return new Date(s.trim().replace(' ', 'T')); } catch { return null; }
}

async function poll() {
  try {
    const campaigns = await getCampaigns();
    const now = Date.now();
    const window = CFG.pollMs * 2; // 2-minute fire window

    for (const c of campaigns) {
      const trigger = (c['Run Trigger'] || '').trim();
      const status  = (c['Status']      || '').trim();

      if (trigger === 'Scheduler' && !status) {
        const t = parseTime(c['test_time']);
        if (!t) continue;
        const diff = now - t.getTime();
        if (diff >= 0 && diff <= window) {
          console.log(`[poll] Firing row ${c.row_number}: ${c.subject}`);
          await axios
            .post(CFG.n8nWebhook, { row_number: c.row_number }, { timeout: 8_000 })
            .catch(e => console.error(`[poll] Row ${c.row_number} error:`, e.message));
        }
      }
    }
  } catch (e) {
    console.error('[poll] Error:', e.message);
  }
}

setInterval(poll, CFG.pollMs);
poll();

// ─── Catch-all → serve frontend ───────────────────────────────────────────────
app.get('*', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(CFG.port, () => {
  console.log(`\n🚀  NxtWave Campaign Manager running on port ${CFG.port}`);
  console.log(`📊  Sheet: https://docs.google.com/spreadsheets/d/${CFG.sheetId}`);
  console.log(`⚡  Polling every ${CFG.pollMs / 1000}s\n`);
});
