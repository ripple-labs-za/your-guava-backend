// The import entry point: parseBuffer reads, validates and groups a POS export into transactions.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { DEFAULT_TIMEZONE, safeTimezone, zonedDayOrdinal } = require('../../utils/timezone');
const { parserLimits, createClientInputError } = require('./limits');
const { sourceRowNumber, addRowError, SOURCE_ROW_NUMBERS } = require('./rowErrors');
const { netPartialRefunds, noteUnitemisedPartialRefunds } = require('./refunds');
const { validateMapping } = require('./headers');
const { assertSupportedFileBuffer } = require('./fileType');
const { groupLinePerRow } = require('./lineItems');
const { inferDayMonthOrder, markMidnightOnlyFileDateOnly } = require('./dates');
const { buildPackedRow } = require('./packedItems');
const { repairOverflowColumns, readCsv } = require('./csv');
const { readWorkbookRows } = require('./xlsx');
const { inferDecimalMark } = require('./numbers');

const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);
// One till whose clock battery died writes 2000-01-01 on a single receipt. That row is wrong; the file is not.
const OUTLIER_DATE_MAX_SHARE = 0.05;
const DAY_MS = 86400000;

/** The run of at most `maxDays` consecutive days holding the most rows (the earliest such run on a tie). */
const dominantDateWindow = (ordinals, maxDays) => {
  const sorted = [...ordinals].sort((a, b) => a - b);
  let best = { start: sorted[0], end: sorted[0], count: 0 };
  for (let lo = 0, hi = 0; hi < sorted.length; hi += 1) {
    while (sorted[hi] - sorted[lo] + 1 > maxDays) lo += 1;
    if (hi - lo + 1 > best.count) best = { start: sorted[lo], end: sorted[hi], count: hi - lo + 1 };
  }
  return best;
};

// zonedDayOrdinal counts UTC-midnight days of the cafe-local date, so this is the cafe-local date key.
const ordinalDateKey = (ordinal) => new Date(ordinal * DAY_MS).toISOString().slice(0, 10);

/**
 * A file wider than the date-range limit used to be refused whole, naming no row, for one till-reset date among
 * 10,000 sales (BE-03-T09). Rows outside the file's densest window become row errors when they are at most 5% of
 * its rows; a file that really spans more than the limit is still refused, naming its two furthest-apart rows.
 */
const excludeOutlierDates = (rows, { maxDays, timezone, rowErrors }) => {
  const ordinals = rows.map((row) => zonedDayOrdinal(row.date, timezone));
  let earliest = 0;
  let latest = 0;
  for (let index = 1; index < ordinals.length; index += 1) {
    if (ordinals[index] < ordinals[earliest]) earliest = index;
    if (ordinals[index] > ordinals[latest]) latest = index;
  }
  const window = dominantDateWindow(ordinals, maxDays);
  if (rows.length - window.count > rows.length * OUTLIER_DATE_MAX_SHARE) {
    throw createClientInputError(`Upload date range exceeds the ${maxDays} day limit. `
      + `Rows ${sourceRowNumber(rows[earliest])} (${ordinalDateKey(ordinals[earliest])}) and ${sourceRowNumber(rows[latest])} `
      + `(${ordinalDateKey(ordinals[latest])}) are the furthest apart; export a shorter period.`);
  }
  const inside = [];
  let errors = 0;
  for (const [index, row] of rows.entries()) {
    if (ordinals[index] >= window.start && ordinals[index] <= window.end) {
      inside.push(row);
      continue;
    }
    // Every source row of the sale is counted: a line-per-row receipt is several rows of the file.
    const sourceRows = row[SOURCE_ROW_NUMBERS]?.length ? row[SOURCE_ROW_NUMBERS] : [sourceRowNumber(row)];
    errors += sourceRows.length;
    addRowError(rowErrors, sourceRows[0], `Date ${ordinalDateKey(ordinals[index])} is far outside the rest of this file `
      + `(${ordinalDateKey(window.start)} to ${ordinalDateKey(window.end)}). Check the till's clock for this sale.`,
    { receiptId: row.receiptId });
  }
  return { rows: inside, errors };
};

/**
 * The rows the date-range limit allows. It runs before refunds are netted: a sale and its refund share a day, so an
 * outlier pair leaves together, where netting first counted the refund both as netted and as an outlier row.
 */
const keepWithinDateLimit = (rows, { maxDays, timezone, rowErrors }) => {
  const { firstDate, lastDate } = dateSpan(rows);
  if (!firstDate || zonedDayOrdinal(lastDate, timezone) - zonedDayOrdinal(firstDate, timezone) + 1 <= maxDays) {
    return { rows, errors: 0 };
  }
  return excludeOutlierDates(rows, { maxDays, timezone, rowErrors });
};

const readPackedRows = (rawRows, columnMapping, timezone, parseContext, rowErrors) => {
  const rows = [];
  let errors = 0;
  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = sourceRowNumber(raw, index);
    try {
      const parsed = buildPackedRow(raw, columnMapping, rowNumber, timezone, parseContext);
      if (parsed.row) {
        rows.push(parsed.row);
      } else {
        errors++;
        addRowError(rowErrors, rowNumber, parsed.error || 'Could not parse row', raw);
      }
    } catch {
      errors++;
      addRowError(rowErrors, rowNumber, 'Could not parse row', raw);
    }
  }
  return { rows, errors };
};

const dateSpan = (rows) => {
  let firstDate = null;
  let lastDate = null;
  for (const r of rows) {
    if (!firstDate || r.date < firstDate) firstDate = r.date;
    if (!lastDate || r.date > lastDate) lastDate = r.date;
  }
  return { firstDate, lastDate };
};

/**
 * Parses a CSV/XLSX buffer using a column mapping.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {object} opts.columnMapping
 * @param {'packed' | 'line-per-row'} opts.itemsMode
 * @param {string} [opts.fileExt='csv']
 * @returns {Promise<{rows: object[], errors: number, rowErrors: object[], totalRows: number, dateRange: {firstDate: Date, lastDate: Date}}>}
 */
const parseBuffer = async (
  buffer,
  { columnMapping, itemsMode = 'packed', fileExt = 'csv', timezone = DEFAULT_TIMEZONE }
) => {
  if (!VALID_ITEMS_MODES.has(itemsMode)) {
    throw new Error(`Invalid itemsMode: ${itemsMode}`);
  }
  const resolvedTimezone = safeTimezone(timezone);
  const normalizedExt = String(fileExt || 'csv').toLowerCase();
  assertSupportedFileBuffer(buffer, normalizedExt);
  validateMapping(columnMapping, itemsMode);
  const limits = parserLimits();
  // CSV goes through prepareCsv (encoding, title lines, quotes; BE-03-T08); a workbook has none of those problems.
  const read = normalizedExt === 'xlsx'
    ? { rows: await readWorkbookRows(buffer), lostRecords: 0, headerRowNumber: 1, encoding: 'xlsx', separator: null }
    : await readCsv(buffer, { limits });
  const { rows: rawRows, ambiguousRows } = repairOverflowColumns(read.rows, columnMapping);
  // Settled once per file from its own values (BE-03-T06); later cards add to this object, none replaces it.
  const csvSeparator = read.separator;
  const parseContext = {
    dateOrder: inferDayMonthOrder(rawRows.map((raw, index) => ({
      value: raw[columnMapping.date], rowNumber: sourceRowNumber(raw, index),
    }))),
    csvSeparator,
    // The quantity column's decimal mark (BE-03-T07): money columns keep the per-cell rule, which reads "105,00" already.
    quantityDecimal: columnMapping.quantity
      ? inferDecimalMark(rawRows.map((raw) => raw[columnMapping.quantity]), { csvSeparator })
      : null,
  };

  let rows;
  let errors = 0;
  let rowErrors = [];
  let nettedRefundRows = 0;
  const dateLimit = { maxDays: limits.maxDateRangeDays, timezone: resolvedTimezone };

  if (itemsMode === 'line-per-row') {
    const grouped = groupLinePerRow(rawRows, columnMapping, resolvedTimezone, parseContext);
    rowErrors = grouped.rowErrors;
    const dated = keepWithinDateLimit(grouped.rows, { ...dateLimit, rowErrors });
    errors = grouped.errors + dated.errors;
    rows = noteUnitemisedPartialRefunds(dated.rows, rowErrors);
  } else {
    const built = readPackedRows(rawRows, columnMapping, resolvedTimezone, parseContext, rowErrors);
    const dated = keepWithinDateLimit(built.rows, { ...dateLimit, rowErrors });
    errors = built.errors + dated.errors;
    // Line-per-row keeps a receipt's lines together, so only packed rows need netting.
    const packed = netPartialRefunds(dated.rows, rowErrors);
    rows = packed.rows;
    nettedRefundRows = packed.nettedRefundRows;
  }

  for (const { rowNumber, overflow } of ambiguousRows) {
    errors += 1;
    addRowError(rowErrors, rowNumber, `Row has ${overflow} more cell${overflow === 1 ? '' : 's'} than there are column headings, `
      + 'so its amounts cannot be trusted. Put the Items cell in quotes, or export the file again.', {});
  }
  if (read.lostRecords > 0) {
    errors += read.lostRecords;
    addRowError(rowErrors, read.headerRowNumber + 1, `${read.lostRecords} line${read.lostRecords === 1 ? ' was' : 's were'} merged `
      + 'by an unbalanced quotation mark and could not be read.', {});
  }

  if (!columnMapping.time) rows = markMidnightOnlyFileDateOnly(rows, resolvedTimezone);

  const { firstDate, lastDate } = dateSpan(rows);

  return {
    rows,
    errors,
    rowErrors,
    totalRows: rawRows.length + ambiguousRows.length + read.lostRecords,
    nettedRefundRows,
    encoding: read.encoding,
    dateRange: { firstDate, lastDate },
    timezone: resolvedTimezone,
  };
};

module.exports = { VALID_ITEMS_MODES, parseBuffer };
