const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const { fetchCampaignRows, getField, updateRowStatus } = require('./sheets');

function parseScheduledTime(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const [, date, hour, minute] = match;
  const offset = config.schedulerTimezone === 'Asia/Kolkata' ? '+05:30' : '+00:00';
  const iso = `${date}T${hour.padStart(2, '0')}:${minute}:00${offset}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isSchedulerRow(row) {
  const runType = getField(row, 'Run Type', 'Run type', 'RunType').toLowerCase();
  const runTrigger = getField(row, 'Run Trigger', 'Run trigger', 'RunTrigger').toLowerCase();
  const status = getField(row, 'Status').toLowerCase();

  if (runType !== 'schedule') return false;
  if (runTrigger !== 'scheduler') return false;
  if (status === 'done') return false;
  if (config.requireApproved && status && status !== 'approved') return false;

  return true;
}

function isDue(scheduledAt, now = new Date()) {
  if (!scheduledAt) return false;

  const windowMs = config.schedulerWindowMs;
  const earliest = new Date(now.getTime() - windowMs);

  return scheduledAt <= now && scheduledAt >= earliest;
}

function buildRowPayload(row) {
  const rowId = getField(row, 'ID', 'Id', 'S.No', 'S No', 'Row ID') || String(row._rowNumber);

  return {
    rowId,
    rowNumber: row._rowNumber,
    sheetId: config.googleSheetId,
    spreadsheetId: config.googleSheetId,
    gid: config.sheetGid,
    channel: getField(row, 'Channel', 'Type'),
    runType: getField(row, 'Run Type', 'Run type'),
    runTrigger: getField(row, 'Run Trigger', 'Run trigger'),
    scheduledTime: getField(row, 'Scheduled Time', 'Scheduled time', 'Schedule Time'),
    message: getField(row, 'Message', 'Subject', 'Title'),
    team: getField(row, 'Team', 'Category'),
    name: getField(row, 'Name', 'Reference', 'Campaign Name'),
    status: getField(row, 'Status'),
    row,
  };
}

async function findDueCampaigns() {
  const rows = await fetchCampaignRows();
  const due = [];

  for (const row of rows) {
    if (!isSchedulerRow(row)) continue;

    const payload = buildRowPayload(row);
    const scheduledAt = parseScheduledTime(payload.scheduledTime);

    if (!scheduledAt) continue;
    if (!isDue(scheduledAt)) continue;

    due.push({ ...payload, scheduledAt: scheduledAt.toISOString() });
  }

  return { scanned: rows.length, due };
}

async function scanAndTrigger(triggerWebhook, broadcast) {
  const { scanned, due } = await findDueCampaigns();

  if (due.length === 0) {
    return { scanned, triggered: 0, campaigns: [] };
  }

  const batchId = uuidv4();
  const campaigns = due.map((item) => ({
    id: `${config.campaignId}-${item.rowId}`,
    webhookUrl: config.n8nWebhookUrl,
    payload: item,
  }));

  broadcast({
    type: 'batch_started',
    batchId,
    total: campaigns.length,
    campaigns: campaigns.map((c) => c.id),
  });

  const results = await Promise.all(campaigns.map((c) => triggerWebhook(c, batchId)));

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'triggered') {
      await updateRowStatus(due[i].rowNumber, config.doneStatus);
    }
  }

  const succeeded = results.filter((r) => r.status === 'triggered').length;
  const failed = results.filter((r) => r.status === 'error').length;

  broadcast({
    type: 'batch_complete',
    batchId,
    total: campaigns.length,
    succeeded,
    failed,
    results,
  });

  return {
    batchId,
    scanned,
    triggered: succeeded,
    failed,
    campaigns: results,
  };
}

module.exports = {
  parseScheduledTime,
  isSchedulerRow,
  isDue,
  findDueCampaigns,
  scanAndTrigger,
  buildRowPayload,
};
