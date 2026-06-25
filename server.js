/**
 * Campaign Orchestrator Server
 * Triggers multiple N8N webhook workflows in parallel
 * Streams real-time status back to clients via WebSocket
 */

require('dotenv').config();

const express = require('express');
const config = require('./config');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { scanAndTrigger, findDueCampaigns } = require('./lib/scheduler');
const { checkConnection } = require('./lib/sheets');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── WebSocket client registry ──────────────────────────────────────────────

const clients = new Map(); // clientId → ws

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  clients.set(clientId, ws);

  ws.send(JSON.stringify({ type: 'connected', clientId }));

  ws.on('close', () => clients.delete(clientId));
  ws.on('error', () => clients.delete(clientId));
});

function broadcast(event) {
  const msg = JSON.stringify({ ...event, ts: Date.now() });
  for (const ws of clients.values()) {
    if (ws.readyState === 1 /* OPEN */) ws.send(msg);
  }
}

// ─── N8N webhook trigger ─────────────────────────────────────────────────────

async function triggerWebhook(campaign, batchId) {
  const { id, webhookUrl, payload = {} } = campaign;

  broadcast({ type: 'campaign_triggering', batchId, campaignId: id });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000); // 30s timeout

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: id, batchId, ...payload }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const result = await res.json().catch(() => ({}));

    broadcast({ type: 'campaign_triggered', batchId, campaignId: id, executionId: result.executionId });
    return { id, status: 'triggered', executionId: result.executionId };

  } catch (err) {
    clearTimeout(timeout);
    const message = err.name === 'AbortError' ? 'Timeout after 30s' : err.message;
    broadcast({ type: 'campaign_error', batchId, campaignId: id, error: message });
    return { id, status: 'error', error: message };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /trigger-campaigns
 * Fire multiple N8N workflows in parallel.
 *
 * Body:
 * {
 *   campaigns: [
 *     { id: "promo-june", webhookUrl: "https://your-n8n/webhook/abc", payload: {} },
 *     { id: "webpush-001", webhookUrl: "https://your-n8n/webhook/xyz", payload: {} }
 *   ]
 * }
 */
app.post('/trigger-campaigns', async (req, res) => {
  const { campaigns } = req.body;

  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    return res.status(400).json({ error: '`campaigns` must be a non-empty array' });
  }

  for (const c of campaigns) {
    if (!c.id || !c.webhookUrl) {
      return res.status(400).json({ error: 'Each campaign needs `id` and `webhookUrl`' });
    }
  }

  const batchId = uuidv4();

  // Respond immediately so client has the batchId to track via WebSocket
  res.json({ batchId, total: campaigns.length, status: 'firing' });

  broadcast({ type: 'batch_started', batchId, total: campaigns.length, campaigns: campaigns.map(c => c.id) });

  // ← All webhooks fire at the same time
  const results = await Promise.all(campaigns.map(c => triggerWebhook(c, batchId)));

  const failed = results.filter(r => r.status === 'error');
  const succeeded = results.filter(r => r.status === 'triggered');

  broadcast({
    type: 'batch_complete',
    batchId,
    total: campaigns.length,
    succeeded: succeeded.length,
    failed: failed.length,
    results,
  });
});

/**
 * POST /trigger-scheduled
 * Fire the configured N8N scheduled-campaign webhook with the Google Sheet ID.
 *
 * Body (all optional):
 * { "sheetId": "...", "gid": 0, ...extra fields forwarded to N8N }
 */
app.post('/trigger-scheduled', async (req, res) => {
  const sheetId = req.body.sheetId || config.googleSheetId;
  const gid = req.body.gid ?? 0;

  const campaign = {
    id: config.campaignId,
    webhookUrl: config.n8nWebhookUrl,
    payload: {
      sheetId,
      spreadsheetId: sheetId,
      sheetUrl: config.googleSheetUrl,
      googleSheetUrl: config.googleSheetUrl,
      gid,
      ...req.body,
    },
  };

  const batchId = uuidv4();
  res.json({ batchId, campaignId: campaign.id, sheetId, gid, status: 'firing' });

  broadcast({
    type: 'batch_started',
    batchId,
    total: 1,
    campaigns: [campaign.id],
  });

  const result = await triggerWebhook(campaign, batchId);

  broadcast({
    type: 'batch_complete',
    batchId,
    total: 1,
    succeeded: result.status === 'triggered' ? 1 : 0,
    failed: result.status === 'error' ? 1 : 0,
    results: [result],
  });
});

/**
 * GET /scheduler/preview
 * List rows that match Scheduler + Schedule and are due now (no webhook fired).
 */
app.get('/scheduler/preview', async (_req, res) => {
  try {
    const { scanned, instant, scheduledFire, scheduledComplete } = await findDueCampaigns();
    res.json({
      scanned,
      instantCount: instant.length,
      scheduledFireCount: scheduledFire.length,
      scheduledCompleteCount: scheduledComplete.length,
      instant,
      scheduledFire,
      scheduledComplete,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /scan-scheduler
 * Manually scan the Google Sheet and fire N8N webhooks for due scheduled rows.
 */
app.post('/scan-scheduler', async (_req, res) => {
  try {
    const result = await scanAndTrigger(triggerWebhook, broadcast);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sheet/status
 * Check if Google Sheet is configured and API credentials can read it.
 */
app.get('/sheet/status', async (_req, res) => {
  const status = await checkConnection();
  res.json(status);
});

/**
 * GET /config
 * Show current campaign defaults (no secrets).
 */
app.get('/config', async (_req, res) => {
  const sheetStatus = await checkConnection();
  res.json({
    campaignId: config.campaignId,
    n8nWorkflowId: config.n8nWorkflowId,
    n8nWebhookUrl: config.n8nWebhookUrl,
    n8nWebhookTestUrl: config.n8nWebhookTestUrl,
    n8nScheduledWebhookUrl: config.n8nScheduledWebhookUrl,
    n8nScheduledWebhookTestUrl: config.n8nScheduledWebhookTestUrl,
    googleSheetId: config.googleSheetId,
    googleSheetUrl: config.googleSheetUrl,
    sheetGid: config.sheetGid,
    sheetConnected: sheetStatus.connected,
    sheetRowCount: sheetStatus.rowCount ?? null,
    sheetError: sheetStatus.error ?? null,
    schedulerEnabled: config.schedulerEnabled,
    schedulerPollMs: config.schedulerPollMs,
    schedulerTimezone: config.schedulerTimezone,
    requireApproved: config.requireApproved,
    doneStatus: config.doneStatus,
    triggeredStatus: config.triggeredStatus,
  });
});

/**
 * POST /callback/:batchId/:campaignId
 * N8N calls this at the END of each workflow to report completion.
 *
 * Add an HTTP Request node at the end of your N8N workflow:
 *   URL: {{ $env.ORCHESTRATOR_URL }}/callback/{{ $json.batchId }}/{{ $json.campaignId }}
 *   Method: POST
 *   Body: { "emailsSent": 1200, "status": "done" }
 */
app.post('/callback/:batchId/:campaignId', (req, res) => {
  const { batchId, campaignId } = req.params;

  broadcast({
    type: 'campaign_finished',
    batchId,
    campaignId,
    data: req.body,
  });

  res.json({ received: true });
});

/**
 * GET /health
 */
app.get('/health', (_req, res) => res.json({ status: 'ok', clients: clients.size }));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Orchestrator listening on :${PORT}`);

  if (config.schedulerEnabled) {
    console.log(`Scheduler polling every ${config.schedulerPollMs / 1000}s`);

    const runScan = async () => {
      try {
        const result = await scanAndTrigger(triggerWebhook, broadcast);
        if (result.triggered > 0 || result.scheduledCompleted > 0) {
          console.log(
            `Scan: instant=${result.instantFired}, scheduled=${result.scheduledFired}, completed=${result.scheduledCompleted}`
          );
        }
      } catch (err) {
        console.error('Scheduler scan failed:', err.message);
      }
    };

    runScan();
    setInterval(runScan, config.schedulerPollMs);
  }
});
