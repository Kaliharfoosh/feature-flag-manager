// CSV export of the audit log (S3), safe to open in Excel, LibreOffice or Google Sheets.
// CSV formula injection: a cell starting with = + - @, a tab or a carriage return is run as a
// formula by spreadsheets (e.g. =HYPERLINK(...) in a flag description). Such cells get a leading
// apostrophe, which makes the spreadsheet show the text instead (OWASP's recommendation).
const COLUMNS = ['at', 'actor', 'category', 'action', 'targetType', 'targetId', 'requestId', 'details'];
const FORMULA_START = /^[=+\-@\t\r]/;

function neutralise(text) {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

// Every cell is quoted, so commas, quotes and line breaks inside values can't break the columns.
function cell(value) {
  if (value === null || value === undefined) return '""';
  let text;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  return `"${neutralise(text).replace(/"/g, '""')}"`;
}

// Takes events as query.js returns them (toApi shape).
function toCsv(events) {
  const lines = [COLUMNS.join(',')];
  for (const e of events) {
    lines.push([e.at, e.actorLabel, e.category, e.action, e.targetType, e.targetId, e.requestId, e.details]
      .map(cell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// audit-<from>-<to>.csv from the validated filters (`to` is already the exclusive bound).
function filename(filters = {}) {
  const day = (d) => d.toISOString().slice(0, 10);
  const to = filters.to ? new Date(filters.to.getTime() - 1) : null;
  return `audit-${filters.from ? day(filters.from) : 'start'}-${to ? day(to) : 'now'}.csv`;
}

module.exports = { toCsv, filename, cell, COLUMNS };
