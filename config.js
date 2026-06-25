/**
 * Campaign defaults — override via environment variables or .env (local dev).
 *
 * N8N workflow: https://academyss.app.n8n.cloud/workflow/a0ltWWzgYCReK63w
 *
 * Instant (Run) webhook:
 *   production: https://academyss.app.n8n.cloud/webhook/campaign-trigger-v2
 *   test:       https://academyss.app.n8n.cloud/webhook-test/campaign-trigger-v2
 *
 * Scheduled (Scheduler) webhook:
 *   production: https://academyss.app.n8n.cloud/webhook/scheduled-campaign-v1
 *   test:       https://academyss.app.n8n.cloud/webhook-test/scheduled-campaign-v1
 */

module.exports = {
  n8nWorkflowId: process.env.N8N_WORKFLOW_ID || 'a0ltWWzgYCReK63w',

  n8nWebhookUrl:
    process.env.N8N_WEBHOOK_URL ||
    'https://academyss.app.n8n.cloud/webhook/campaign-trigger-v2',

  n8nWebhookTestUrl:
    process.env.N8N_WEBHOOK_TEST_URL ||
    'https://academyss.app.n8n.cloud/webhook-test/campaign-trigger-v2',

  n8nScheduledWebhookUrl:
    process.env.N8N_SCHEDULED_WEBHOOK_URL ||
    'https://academyss.app.n8n.cloud/webhook/scheduled-campaign-v1',

  n8nScheduledWebhookTestUrl:
    process.env.N8N_SCHEDULED_WEBHOOK_TEST_URL ||
    'https://academyss.app.n8n.cloud/webhook-test/scheduled-campaign-v1',

  googleSheetId:
    process.env.GOOGLE_SHEET_ID ||
    '166dxm8lGoJu2L83JfYc11G5Y8cZZZeMMbSHpsUyV1kI',

  sheetGid: Number(process.env.SHEET_GID || 0),

  get googleSheetUrl() {
    if (process.env.GOOGLE_SHEET_URL) return process.env.GOOGLE_SHEET_URL;
    const id = process.env.GOOGLE_SHEET_ID || '166dxm8lGoJu2L83JfYc11G5Y8cZZZeMMbSHpsUyV1kI';
    const gid = process.env.SHEET_GID || 0;
    return `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${gid}#gid=${gid}`;
  },

  campaignId: process.env.CAMPAIGN_ID || 'scheduled-campaign',

  // Poll sheet every N ms for Run Trigger=Scheduler + Run Type=Schedule rows
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
  schedulerPollMs: Number(process.env.SCHEDULER_POLL_MS || 60_000),
  schedulerTimezone: process.env.SCHEDULER_TIMEZONE || 'Asia/Kolkata',
  schedulerWindowMs: Number(process.env.SCHEDULER_WINDOW_MS || 5 * 60_000),
  requireApproved: process.env.REQUIRE_APPROVED !== 'false',
  doneStatus: process.env.DONE_STATUS || 'Done',
  triggeredStatus: process.env.TRIGGERED_STATUS || 'Triggered',
};
