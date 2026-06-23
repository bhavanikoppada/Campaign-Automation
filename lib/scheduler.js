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

function hasChannelSelected(row) {
  return Boolean(getField(row, 'Channel', 'Type'));
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

function isApproved(status) {
  const s = status.toLowerCase();
  if (s === config.doneStatus.toLowerCase() || s === config.triggeredStatus.toLowerCase()) {
    return false;
  }
  if (config.requireApproved) return s === 'approved';
  return true;
}

function isInstantRunRow(row) {
  const runType = getField(row, 'Run Type', 'Run type', 'RunType').toLowerCase();
  const runTrigger = getField(row, 'Run Trigger', 'Run trigger', 'RunTrigger').toLowerCase();
  const status = getField(row, 'Status');

  return (
    hasChannelSelected(row) &&
    runType === 'instant' &&
    runTrigger === 'run' &&
    isApproved(status)
  );
}

function isScheduledFireRow(row) {
  const runType = getField(row, 'Run Type', 'Run type', 'RunType').toLowerCase();
  const runTrigger = getField(row, 'Run Trigger', 'Run trigger', 'RunTrigger').toLowerCase();
  const status = getField(row, 'Status');

  return (
    hasChannelSelected(row) &&
    (runType === 'schedule' || runType === 'scheduled') &&
    runTrigger === 'scheduler' &&
    isApproved(status)
  );
}

function isScheduledCompleteRow(row) {
  const runType = getField(row, 'Run Type', 'Run type', 'RunType').toLowerCase();
  const runTrigger = getField(row, 'Run Trigger', 'Run trigger', 'RunTrigger').toLowerCase();
  const status = getField(row, 'Status').toLowerCase();

  return (
    hasChannelSelected(row) &&
    (runType === 'schedule' || runType === 'scheduled') &&
    runTrigger === 'scheduler' &&
    status === config.triggeredStatus.toLowerCase()
  );
}

function isDue(scheduledAt, now = new Date()) {
  if (!scheduledAt) return false;

  const windowMs = config.schedulerWindowMs;
  const earliest = new Date(now.getTime() - windowMs);

  return scheduledAt <= now && scheduledAt >= earliest;
}

function isPastScheduledTime(scheduledAt, now = new Date()) {
  return scheduledAt && scheduledAt <= now;
}

function classifyRows(rows) {
  const instant = [];
  const scheduledFire = [];
  const scheduledComplete = [];

  for (const row of rows) {
    const payload = buildRowPayload(row);
    const scheduledAt = parseScheduledTime(payload.scheduledTime);

    if (isScheduledCompleteRow(row)) {
      if (isPastScheduledTime(scheduledAt)) {
        scheduledComplete.push({ ...payload, scheduledAt: scheduledAt?.toISOString() });
      }
      continue;
    }

    if (isInstantRunRow(row)) {
      instant.push(payload);
      continue;
    }

    if (isScheduledFireRow(row) && scheduledAt && isDue(scheduledAt)) {
      scheduledFire.push({ ...payload, scheduledAt: scheduledAt.toISOString() });
    }
  }

  return { instant, scheduledFire, scheduledComplete };
}

async function findDueCampaigns() {
  const rows = await fetchCampaignRows();
  const { instant, scheduledFire, scheduledComplete } = classifyRows(rows);

  return {
    scanned: rows.length,
    instant,
    scheduledFire,
    scheduledComplete,
    due: [...instant, ...scheduledFire],
  };
}

async function fireCampaigns(items, triggerWebhook, broadcast, onSuccessStatus) {
  if (items.length === 0) return { batchId: null, results: [], succeeded: 0, failed: 0 };

  const batchId = uuidv4();
  const campaigns = items.map((item) => ({
    id: `${config.campaignId}-${item.rowId}`,
    webhookUrl: config.n8nWebhookUrl,
    payload: { ...item, mode: onSuccessStatus === config.doneStatus ? 'instant' : 'scheduled' },
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
      await updateRowStatus(items[i].rowNumber, onSuccessStatus);
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

  return { batchId, results, succeeded, failed };
}

async function markScheduledComplete(items) {
  let completed = 0;

  for (const item of items) {
    await updateRowStatus(item.rowNumber, config.doneStatus);
    completed++;
  }

  return completed;
}

async function scanAndTrigger(triggerWebhook, broadcast) {
  const rows = await fetchCampaignRows();
  const { instant, scheduledFire, scheduledComplete } = classifyRows(rows);

  const completeCount = await markScheduledComplete(scheduledComplete);

  const instantResult = await fireCampaigns(
    instant,
    triggerWebhook,
    broadcast,
    config.doneStatus
  );

  const scheduledResult = await fireCampaigns(
    scheduledFire,
    triggerWebhook,
    broadcast,
    config.triggeredStatus
  );

  return {
    scanned: rows.length,
    instantFired: instantResult.succeeded,
    scheduledFired: scheduledResult.succeeded,
    scheduledCompleted: completeCount,
    triggered: instantResult.succeeded + scheduledResult.succeeded,
    failed: instantResult.failed + scheduledResult.failed,
    batches: [instantResult.batchId, scheduledResult.batchId].filter(Boolean),
    instant: instantResult.results,
    scheduled: scheduledResult.results,
    completed: scheduledComplete.map((r) => r.rowId),
  };
}

module.exports = {
  parseScheduledTime,
  isDue,
  findDueCampaigns,
  scanAndTrigger,
  buildRowPayload,
  classifyRows,
  isInstantRunRow,
  isScheduledFireRow,
  isScheduledCompleteRow,
};
