const { google } = require('googleapis');
const config = require('../config');

let sheetsClient;

function getCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    return credPath;
  }

  return null;
}

function hasCredentials() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

async function checkConnection() {
  if (!hasCredentials()) {
    return {
      connected: false,
      googleSheetId: config.googleSheetId,
      googleSheetUrl: config.googleSheetUrl,
      error:
        'Google credentials missing. Add GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON.',
    };
  }

  try {
    const rows = await fetchCampaignRows();
    return {
      connected: true,
      googleSheetId: config.googleSheetId,
      googleSheetUrl: config.googleSheetUrl,
      sheetGid: config.sheetGid,
      rowCount: rows.length,
    };
  } catch (err) {
    return {
      connected: false,
      googleSheetId: config.googleSheetId,
      googleSheetUrl: config.googleSheetUrl,
      error: err.message,
    };
  }
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const credentials = getCredentials();
  if (!credentials) {
    throw new Error(
      'Google Sheets credentials missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.'
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: typeof credentials === 'string' ? undefined : credentials,
    keyFile: typeof credentials === 'string' ? credentials : undefined,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function rowToObject(headers, values, rowIndex) {
  const row = { _rowNumber: rowIndex };

  headers.forEach((header, i) => {
    if (header) row[header] = values[i] ?? '';
  });

  return row;
}

function getField(row, ...aliases) {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const normalized = normalizeHeader(alias);
    const match = keys.find((k) => normalizeHeader(k) === normalized);
    if (match !== undefined && row[match] !== undefined && row[match] !== '') {
      return String(row[match]).trim();
    }
  }
  return '';
}

let sheetContext;

function columnToLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function getSheetContext() {
  if (sheetContext) return sheetContext;

  const sheets = await getSheetsClient();
  const spreadsheetId = config.googleSheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet =
    meta.data.sheets.find((s) => s.properties.sheetId === config.sheetGid) ||
    meta.data.sheets[0];

  const sheetTitle = sheet.properties.title;
  const range = `${sheetTitle}!A1:Z1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const headers = (res.data.values?.[0] || []).map((h) => String(h || '').trim());

  const statusColumnIndex = headers.findIndex((h) => normalizeHeader(h) === 'status');
  if (statusColumnIndex < 0) {
    throw new Error('Status column not found in sheet header row');
  }

  sheetContext = { sheetTitle, headers, statusColumnIndex };
  return sheetContext;
}

function clearSheetContext() {
  sheetContext = undefined;
}

async function updateRowStatus(rowNumber, status = config.doneStatus) {
  const sheets = await getSheetsClient();
  const ctx = await getSheetContext();
  const col = columnToLetter(ctx.statusColumnIndex);
  const range = `${ctx.sheetTitle}!${col}${rowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.googleSheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status]] },
  });

  clearSheetContext();
}

async function fetchCampaignRows() {
  const sheets = await getSheetsClient();
  const ctx = await getSheetContext();
  const range = `${ctx.sheetTitle}!A:Z`;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range,
  });
  const rows = res.data.values || [];

  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).map((values, i) => rowToObject(headers, values, i + 2));
}

module.exports = { fetchCampaignRows, getField, normalizeHeader, updateRowStatus, hasCredentials, checkConnection };
