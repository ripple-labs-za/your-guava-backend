// Line-per-row receipts: unit-price source, totals-mode inference and grouping rows into transactions.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { zonedDateKey } = require('../../utils/timezone');
const { parserLimits } = require('./limits');
const { sourceRowNumber, addRowError, setSourceRowNumbers, SOURCE_ROW_NUMBERS, receiptIdError } = require('./rowErrors');
const { parseQuantity, parseBoundedAmount, parseOptionalAmount } = require('./numbers');
const { parseDateTime, transactionDateError, temporalFields } = require('./dates');

/**
 * A packed receipt carries one total for the whole basket. With a single
 * distinct item the unit price is exact (total / quantity); with several it
 * can only be a basket average. The average keeps per-item revenue summing to
 * the receipt, which analytics relies on, but it is not a price -- the menu
 * used to learn it as one, so nearly every item showed a false "price
 * differs" warning. The flag lets price learning and mismatch checks skip it.
 */
const unitPriceSource = (items, { tip = 0, discount = 0, hasRefund = false } = {}) => {
  // A refund or a void is a correction, not a price observation. Its arithmetic
  // can even divide to zero, which must never be learned as a menu price.
  if (hasRefund) return 'derived';
  // A tip or discount lands in the receipt total, so total / quantity is the
  // menu price plus the tip (or minus the discount), not the price itself.
  // One tipped single-item receipt was enough to seed an item 18% high and
  // flag every later sale as a mismatch.
  if (Number(tip) !== 0 || Number(discount) !== 0) return 'derived';
  return new Set(items.map((item) => item.name)).size === 1 ? 'exact' : 'derived';
};

const LINE_AMOUNT_HEADER_RE = /(^|\s)(line|item)(\s|$)/i;
const TOTALS_MODE_CONSENSUS = 0.9;
// Below this many multi-row receipts the vote is trivially unanimous: a lone
// receipt with two items at the same price is an everyday coincidence, not
// evidence that the file repeats receipt totals.
const MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE = 5;

const headerSuggestsLineAmounts = (mapping) =>
  LINE_AMOUNT_HEADER_RE.test(String(mapping.total || '').replace(/[_-]+/g, ' '));

/**
 * Decides, per file, whether each row's total is a line amount (summed into
 * the receipt) or the receipt total repeated on every line (taken once).
 *
 * This used to be read off the mapped column's NAME: anything containing
 * "line" or "item" was summed. A till that repeats the order total under a
 * header like "Item Total" then had every receipt multiplied by its line
 * count, and revenue inflated silently. The data settles it: across receipts
 * with two or more rows, near-unanimous identical totals mean receipt totals
 * and near-unanimous differing totals mean line amounts. Only when neither
 * reading reaches consensus, or too few receipts have more than one row to
 * be evidence, does the header decide as before.
 */
const inferTotalsAreLineAmounts = (groups, mapping) => {
  let identical = 0;
  let differing = 0;
  for (const group of groups.values()) {
    if (group.invalidReason || group.totals.length < 2) continue;
    const uniqueTotals = new Set(group.totals.map((total) => Number(total.toFixed(2))));
    if (uniqueTotals.size === 1) identical++;
    else differing++;
  }
  const multiRowReceipts = identical + differing;
  if (multiRowReceipts >= MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE) {
    if (identical / multiRowReceipts >= TOTALS_MODE_CONSENSUS) return false;
    if (differing / multiRowReceipts >= TOTALS_MODE_CONSENSUS) return true;
  }
  return headerSuggestsLineAmounts(mapping);
};

const groupLinePerRow = (rawRows, mapping, timezone, context = {}) => {
  const limits = parserLimits();
  const groups = new Map();
  const rowErrors = [];
  let errors = 0;

  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = sourceRowNumber(raw, index);
    try {
      const { date, timeKnown } = parseDateTime(raw[mapping.date], mapping.time && raw[mapping.time], timezone, context);
      if (!date) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Could not parse date or time', raw);
        continue;
      }
      const dateError = transactionDateError(date, timezone);
      if (dateError) {
        errors++;
        addRowError(rowErrors, rowNumber, dateError, raw);
        continue;
      }
      const receiptId = String(raw[mapping.receiptId] || '').trim();
      if (!receiptId) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Missing receipt ID', raw);
        continue;
      }
      const receiptError = receiptIdError(receiptId, limits);
      if (receiptError) {
        errors++;
        addRowError(rowErrors, rowNumber, receiptError, raw);
        continue;
      }
      // Receipt numbers are only unique within a day on most tills -- plenty
      // restart their order numbers each morning. Keyed on the receipt alone,
      // the same number on two days collided, the date mismatch was flagged as
      // conflicting rows, and the whole group was rejected: a till that
      // restarts numbering could not import at all.
      const groupKey = `${zonedDateKey(date, timezone)}::${receiptId}`;
      const itemName = String(raw[mapping.items] || '').trim();
      if (!itemName) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Missing item name', raw);
        continue;
      }
      if (itemName.length > limits.maxItemNameChars) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Item name exceeds the ${limits.maxItemNameChars} character limit`,
          raw
        );
        continue;
      }
      const quantity = mapping.quantity
        ? parseQuantity(raw[mapping.quantity], limits, { decimalMark: context.quantityDecimal })
        : 1;
      if (!quantity) {
        errors++;
        addRowError(rowErrors, rowNumber, 'Invalid item quantity', raw);
        continue;
      }
      const total = parseBoundedAmount(raw[mapping.total], limits);
      if (total === null) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Invalid transaction total or amount exceeds ${limits.maxAbsoluteAmount}`,
          raw
        );
        continue;
      }
      const parsedTip = parseOptionalAmount(mapping.tip && raw[mapping.tip], 'Tip', limits);
      const parsedDiscount = parseOptionalAmount(
        mapping.discount && raw[mapping.discount],
        'Discount',
        limits
      );
      if (parsedTip.error || parsedDiscount.error) {
        errors++;
        addRowError(rowErrors, rowNumber, parsedTip.error || parsedDiscount.error, raw);
        continue;
      }
      const tip = parsedTip.value;
      const discount = parsedDiscount.value;
      const paymentMethod = mapping.paymentMethod
        ? String(raw[mapping.paymentMethod] || '').trim()
        : '';
      if (paymentMethod.length > limits.maxIdentifierChars) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Payment method exceeds the ${limits.maxIdentifierChars} character limit`,
          raw
        );
        continue;
      }
      if (!groups.has(groupKey)) {
        groups.set(groupKey, setSourceRowNumbers({
          receiptId,
          date,
          ...temporalFields(date, timezone, { timeKnown }),
          items: [],
          totals: [],
          tip,
          discount,
          paymentMethod: paymentMethod || undefined,
          status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
          statusRaw: mapping.status ? String(raw[mapping.status] || '').trim() : '',
          invalidReason: undefined,
        }, []));
      }
      const group = groups.get(groupKey);
      const status = mapping.status
        ? String(raw[mapping.status] || 'approved').trim().toLowerCase()
        : 'approved';
      const inconsistent =
        group.date.getTime() !== date.getTime() ||
        Number(group.tip || 0) !== Number(tip || 0) ||
        Number(group.discount || 0) !== Number(discount || 0) ||
        String(group.paymentMethod || '') !== String(paymentMethod || '') ||
        String(group.status || 'approved') !== status;
      if (inconsistent) {
        // The rows already accepted into this receipt are discarded with it, so
        // count them and name them. Counting one error while dropping four rows
        // under-reported the damage: the owner reconciled against the till
        // report, found revenue missing, and the error list gave them no row
        // number to look at.
        const discarded = group.invalidReason ? [] : group[SOURCE_ROW_NUMBERS];
        errors += 1 + discarded.length;
        group.invalidReason =
          'Rows sharing a receipt ID have conflicting date, time, payment, status, tip, or discount values';
        addRowError(
          rowErrors,
          rowNumber,
          discarded.length > 0
            ? `${group.invalidReason}. Receipt ${receiptId} was dropped, including rows ${discarded.join(', ')}`
            : group.invalidReason,
          { receiptId }
        );
        continue;
      }
      if (group.items.length >= limits.maxItemsPerTransaction) {
        errors++;
        addRowError(
          rowErrors,
          rowNumber,
          `Transaction exceeds the ${limits.maxItemsPerTransaction} item limit`,
          raw
        );
        continue;
      }
      group[SOURCE_ROW_NUMBERS].push(rowNumber);
      group.items.push({ name: itemName, quantity, lineTotal: total });
      group.totals.push(total);
    } catch {
      errors++;
      addRowError(rowErrors, rowNumber, 'Could not parse row', raw);
    }
  }
  const totalsAreLineAmounts = inferTotalsAreLineAmounts(groups, mapping);
  const rows = [];
  for (const row of groups.values()) {
    if (row.invalidReason) continue;
    const uniqueTotals = [...new Set(row.totals.map((total) => Number(total.toFixed(2))))];
    if (!totalsAreLineAmounts && uniqueTotals.length !== 1) {
      // Every source row of this receipt is discarded, not just the first.
      errors += row[SOURCE_ROW_NUMBERS]?.length || 1;
      addRowError(
        rowErrors,
        row[SOURCE_ROW_NUMBERS]?.[0] || 1,
        `Rows sharing a receipt ID have conflicting receipt totals. Map a column labelled as a line/item amount when each row is a line amount. Receipt ${row.receiptId} was dropped, including rows ${(row[SOURCE_ROW_NUMBERS] || []).join(', ')}`,
        { receiptId: row.receiptId }
      );
      continue;
    }
    const total = totalsAreLineAmounts
      ? row.totals.reduce((sum, value) => sum + value, 0)
      : uniqueTotals[0];
    if (!Number.isFinite(total) || Math.abs(total) > limits.maxAbsoluteAmount) {
      errors += row[SOURCE_ROW_NUMBERS]?.length || 1;
      addRowError(
        rowErrors,
        row[SOURCE_ROW_NUMBERS]?.[0] || 1,
        `Transaction total exceeds the ${limits.maxAbsoluteAmount} amount limit`,
        { receiptId: row.receiptId }
      );
      continue;
    }
    const hasRefund = row.items.some((item) => item.quantity < 0);
    // Magnitudes, as the packed path does: a receipt mixing a sale and a refund can net its quantity to zero, which
    // priced the refund line at 0 and marked it exact (BE-03-T07).
    const absQty = row.items.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
    const averageUnitPrice = absQty > 0 ? parseFloat((Math.abs(total) / absQty).toFixed(2)) : 0;
    const receiptPriceSource = unitPriceSource(row.items, { tip: row.tip, discount: row.discount, hasRefund });
    const { totals, invalidReason, ...cleanRow } = row;
    rows.push(setSourceRowNumbers({
      ...cleanRow,
      total,
      items: row.items.map(({ lineTotal, ...item }) => (totalsAreLineAmounts
        ? {
          ...item,
          // The line's own amount over its own quantity; the sign stays on the quantity. A refund or void line is a
          // correction, not a price the till charged, so it is never learned as one.
          unitPrice: parseFloat(Math.abs(lineTotal / item.quantity).toFixed(2)),
          priceSource: item.quantity < 0 || lineTotal < 0 ? 'derived' : 'exact',
        }
        : { ...item, unitPrice: averageUnitPrice, priceSource: receiptPriceSource })),
    }, row[SOURCE_ROW_NUMBERS] || []));
  }
  return { rows, errors, rowErrors, totalsAreLineAmounts };
};

module.exports = {
  unitPriceSource, groupLinePerRow,
};
