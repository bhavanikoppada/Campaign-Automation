/**
 * Campaign defaults — override via environment variables or .env (local dev).
 *
 * N8N note: /webhook-test/ only works while "Listen for test event" is active in the editor.
 * For live/production runs, use /webhook/campaign-trigger (activate the workflow first).
 */

module.exports = {
  n8nWebhookUrl:
    process.env.N8N_WEBHOOK_URL ||
    'https://academyss.app.n8n.cloud/webhook-test/campaign-trigger',

  googleSheetId:
    process.env.GOOGLE_SHEET_ID ||
    '166dxm8lGoJu2L83JfYc11G5Y8cZZZeMMbSHpsUyV1kI',

  sheetGid: Number(process.env.SHEET_GID || 0),

  campaignId: process.env.CAMPAIGN_ID || 'scheduled-campaign',

  // Poll sheet every N ms for Run Trigger=Scheduler + Run Type=Schedule rows
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
  schedulerPollMs: Number(process.env.SCHEDULER_POLL_MS || 60_000),
  schedulerTimezone: process.env.SCHEDULER_TIMEZONE || 'Asia/Kolkata',
  schedulerWindowMs: Number(process.env.SCHEDULER_WINDOW_MS || 5 * 60_000),
  requireApproved: process.env.REQUIRE_APPROVED !== 'false',
  doneStatus: process.env.DONE_STATUS || 'Done',
};
