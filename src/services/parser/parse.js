// The import entry point: parseBuffer reads, validates and groups a POS export into transactions.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { DEFAULT_TIMEZONE, safeTimezone, zonedDayOrdinal } = require('../../utils/timezone');
const { parserLimits, createClientInputError } = require('./limits');
const { sourceRowNumber, addRowError } = require('./rowErrors');
const { netPartialRefunds, noteUnitemisedPartialRefunds } = require('./refunds');
const { validateMapping } = require('./headers');
const { assertSupportedFileBuffer } = require('./fileType');
const { groupLinePerRow } = require('./lineItems');
const { inferDayMonthOrder, markMidnightOnlyFileDateOnly } = require('./dates');
const { buildPackedRow } = require('./packedItems');
const { repairOverflowColumns, readRows, detectCsvSeparator } = require('./csv');
const { inferDecimalMark } = require('./numbers');

const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);

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
  const rawRows = repairOverflowColumns(await readRows(buffer, normalizedExt), columnMapping);
  // Settled once per file from its own values (BE-03-T06); later cards add to this object, none replaces it.
  const csvSeparator = normalizedExt === 'csv' ? detectCsvSeparator(buffer) : null;
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

  if (itemsMode === 'line-per-row') {
    const grouped = groupLinePerRow(rawRows, columnMapping, resolvedTimezone, parseContext);
    errors = grouped.errors;
    rowErrors = grouped.rowErrors;
    rows = noteUnitemisedPartialRefunds(grouped.rows, rowErrors);
  } else {
    rows = [];
    for (const [index, raw] of rawRows.entries()) {
      const rowNumber = sourceRowNumber(raw, index);
      try {
        const parsed = buildPackedRow(raw, columnMapping, rowNumber, resolvedTimezone, parseContext);
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
    // Line-per-row keeps a receipt's lines together, so only packed rows need netting.
    const packed = netPartialRefunds(rows, rowErrors);
    rows = packed.rows;
    nettedRefundRows = packed.nettedRefundRows;
  }

  if (!columnMapping.time) rows = markMidnightOnlyFileDateOnly(rows, resolvedTimezone);

  let firstDate = null;
  let lastDate = null;
  for (const r of rows) {
    if (!firstDate || r.date < firstDate) firstDate = r.date;
    if (!lastDate || r.date > lastDate) lastDate = r.date;
  }
  if (firstDate && lastDate) {
    const rangeDays = zonedDayOrdinal(lastDate, resolvedTimezone) -
      zonedDayOrdinal(firstDate, resolvedTimezone) + 1;
    if (rangeDays > parserLimits().maxDateRangeDays) {
      throw createClientInputError(
        `Upload date range exceeds the ${parserLimits().maxDateRangeDays} day limit`
      );
    }
  }

  return {
    rows,
    errors,
    rowErrors,
    totalRows: rawRows.length,
    nettedRefundRows,
    dateRange: { firstDate, lastDate },
    timezone: resolvedTimezone,
  };
};

module.exports = { VALID_ITEMS_MODES, parseBuffer };
