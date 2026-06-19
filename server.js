/**
 * Campaign Orchestrator Server
 * Triggers multiple N8N webhook workflows in parallel
 * Streams real-time status back to clients via WebSocket
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

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
server.listen(PORT, () => console.log(`Orchestrator listening on :${PORT}`));
