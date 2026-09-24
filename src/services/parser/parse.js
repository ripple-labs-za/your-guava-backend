// The import entry point: parseBuffer reads, validates and groups a POS export into transactions.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { DEFAULT_TIMEZONE, safeTimezone, zonedDayOrdinal } = require('../../utils/timezone');
const { parserLimits, createClientInputError } = require('./limits');
const { sourceRowNumber, addRowError, setSourceRowNumbers, SOURCE_ROW_NUMBERS } = require('./rowErrors');
const { normaliseTransactionStatus, isRefundStatus } = require('../../utils/transactionStatus');
const { validateMapping } = require('./headers');
const { assertSupportedFileBuffer } = require('./fileType');
const { groupLinePerRow } = require('./lineItems');
const { inferDayMonthOrder, markMidnightOnlyFileDateOnly } = require('./dates');
const { buildPackedRow } = require('./packedItems');
const { repairOverflowColumns, readRows, detectCsvSeparator } = require('./csv');
const { inferDecimalMark } = require('./numbers');

const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);

/**
 * A packed export may mark a sale "Partially Refunded" and carry the refund as its own "Refunded" row with the same
 * receipt number on the same day. The refund is netted into the sale, which then carries what the cafe kept. A refund
 * row that matches no partially refunded sale is left alone (skipped by status, as before). See DECISIONS D-021.
 */
const netPartialRefunds = (rows, rowErrors) => {
  const saleKey = (row) => `${row.receiptId}|${row.dateKey}`;
  const isPartialSale = (row) => Boolean(row.receiptId) && Boolean(normaliseTransactionStatus(row.status).partialRefund);
  const partialSales = new Set(rows.filter(isPartialSale).map(saleKey));
  const refundsBySale = new Map();
  const kept = [];
  for (const row of rows) {
    if (row.receiptId && isRefundStatus(row.status) && partialSales.has(saleKey(row))) {
      refundsBySale.set(saleKey(row), [...(refundsBySale.get(saleKey(row)) || []), row]);
    } else {
      kept.push(row);
    }
  }
  const netted = kept.map((row) => {
    if (!isPartialSale(row)) return row;
    const refunds = refundsBySale.get(saleKey(row)) || [];
    if (refunds.length === 0) {
      addRowError(rowErrors, sourceRowNumber(row), `Receipt ${row.receiptId} is marked Partially Refunded, but the file has no `
        + `refund row for it, so its full R${Number(row.total).toFixed(2)} was imported.`, { receiptId: row.receiptId });
      return row;
    }
    const refunded = refunds.reduce((sum, refund) => sum + Math.abs(refund.total), 0);
    const retained = parseFloat((row.total - refunded).toFixed(2));
    if (retained < 0) {
      // More refunded than sold is a contradiction in the file: import what it says, but never silently.
      addRowError(rowErrors, sourceRowNumber(row), `Receipt ${row.receiptId} refunds R${refunded.toFixed(2)}, more than its sale `
        + `of R${Number(row.total).toFixed(2)}, so it was imported at -R${Math.abs(retained).toFixed(2)}. Check the till for a `
        + 'refund recorded against the wrong receipt.', { receiptId: row.receiptId });
    }
    return setSourceRowNumbers({
      ...row,
      total: retained,
      items: [
        ...row.items,
        ...refunds.flatMap((refund) => refund.items.map((item) => ({ ...item, quantity: -Math.abs(item.quantity) }))),
      ].map((item) => ({ ...item, priceSource: 'derived' })),
    }, [...(row[SOURCE_ROW_NUMBERS] || []), ...refunds.flatMap((refund) => refund[SOURCE_ROW_NUMBERS] || [])]);
  });
  return { rows: netted, nettedRefundRows: rows.length - kept.length };
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
    rows = grouped.rows;
    errors = grouped.errors;
    rowErrors = grouped.rowErrors;
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
