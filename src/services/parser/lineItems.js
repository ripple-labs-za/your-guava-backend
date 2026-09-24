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
// Below this many multi-row receipts the vote is trivially unanimous: a lone
// receipt with two items at the same price is an everyday coincidence, not
// evidence that the file repeats receipt totals.
const MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE = 5;
// Evidence is asymmetric: a receipt whose line amounts differ cannot come from a file that repeats the receipt
// total, while two items at the same price are an everyday coincidence in a line-amount file (BE-03-T09).
const LINE_AMOUNT_EVIDENCE_SHARE = 0.3;
const RECEIPT_TOTAL_CONSENSUS = 0.9;
// A receipt's lines are one sale. Tills stamp each line as it is rung up, seconds apart; lines of one receipt
// spanning more than a few minutes are two sales under one number and still conflict.
const RECEIPT_LINE_TIME_TOLERANCE_MS = 5 * 60 * 1000;

const isBlank = (value) => value == null || String(value).trim() === '';

const headerSuggestsLineAmounts = (mapping) =>
  LINE_AMOUNT_HEADER_RE.test(String(mapping.total || '').replace(/[_-]+/g, ' '));

/** Receipts with two or more lines, split by whether their stated line totals are all the same. */
const totalsEvidence = (groups) => {
  let identical = 0;
  let differing = 0;
  for (const group of groups.values()) {
    if (group.invalidReason || group.totals.length < 2) continue;
    const stated = group.totals.filter((total) => total != null);
    // A blank amount on a later line is how receipt-total files write continuation lines.
    if (stated.length < group.totals.length) { identical += 1; continue; }
    if (new Set(stated.map((total) => Number(total.toFixed(2)))).size === 1) identical += 1;
    else differing += 1;
  }
  return { identical, differing };
};

/**
 * Decides, per file, whether each row's total is a line amount (summed into
 * the receipt) or the receipt total repeated on every line (taken once).
 *
 * This used to be read off the mapped column's NAME: anything containing
 * "line" or "item" was summed. A till that repeats the order total under a
 * header like "Item Total" then had every receipt multiplied by its line
 * count, and revenue inflated silently. The data settles it. It then needed 90%
 * agreement either way, so a line file headed "Amount" whose receipts were 70%
 * differing fell back to receipt totals and lost those 70% (BE-03-T09). Below
 * the minimum count, differing receipts decide only when none repeats a total:
 * one mistyped receipt among a few repeated totals would otherwise double the
 * good ones silently, where the header reading refuses only the bad one, with
 * a row error. Only when neither reading has its evidence does the header
 * decide.
 */
const decideTotalsMode = ({ identical, differing }, mapping) => {
  const multi = identical + differing;
  const enoughReceipts = multi >= MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE || (differing > 0 && identical === 0);
  if (enoughReceipts && differing / multi >= LINE_AMOUNT_EVIDENCE_SHARE) {
    return { lineAmounts: true, decidedBy: 'data', identical, differing };
  }
  if (multi >= MIN_MULTI_ROW_RECEIPTS_FOR_INFERENCE && identical / multi >= RECEIPT_TOTAL_CONSENSUS) {
    return { lineAmounts: false, decidedBy: 'data', identical, differing };
  }
  return { lineAmounts: headerSuggestsLineAmounts(mapping), decidedBy: 'header', identical, differing };
};

/** The receipt a row belongs to, or why it belongs to none. */
const readReceiptKey = (raw, mapping, timezone, context, limits) => {
  const { date, timeKnown } = parseDateTime(raw[mapping.date], mapping.time && raw[mapping.time], timezone, context);
  if (!date) return { error: 'Could not parse date or time' };
  const dateError = transactionDateError(date, timezone);
  if (dateError) return { error: dateError };
  const receiptId = String(raw[mapping.receiptId] || '').trim();
  if (!receiptId) return { error: 'Missing receipt ID' };
  const receiptError = receiptIdError(receiptId, limits);
  if (receiptError) return { error: receiptError };
  // Receipt numbers are only unique within a day on most tills -- plenty
  // restart their order numbers each morning. Keyed on the receipt alone,
  // the same number on two days collided, the date mismatch was flagged as
  // conflicting rows, and the whole group was rejected: a till that
  // restarts numbering could not import at all.
  return { date, timeKnown, receiptId, groupKey: `${zonedDateKey(date, timezone)}::${receiptId}` };
};

/**
 * One line's own cells, and which receipt-level cells it actually states. Exports write payment, status and tip on
 * a receipt's first line only; a blank there is silence, not a different value (BE-03-T09). A continuation line
 * may leave its amount blank, as receipt-total files do; a line-amount file that does so is refused once the file's
 * totals mode is known.
 */
const readLineCells = (raw, mapping, context, limits, continuation) => {
  const itemName = String(raw[mapping.items] || '').trim();
  if (!itemName) return { error: 'Missing item name' };
  if (itemName.length > limits.maxItemNameChars) {
    return { error: `Item name exceeds the ${limits.maxItemNameChars} character limit` };
  }
  const quantity = mapping.quantity
    ? parseQuantity(raw[mapping.quantity], limits, { decimalMark: context.quantityDecimal })
    : 1;
  if (!quantity) return { error: 'Invalid item quantity' };
  const totalLeftBlank = continuation && isBlank(raw[mapping.total]);
  const lineTotal = totalLeftBlank ? null : parseBoundedAmount(raw[mapping.total], limits);
  if (lineTotal === null && !totalLeftBlank) {
    return { error: `Invalid transaction total or amount exceeds ${limits.maxAbsoluteAmount}` };
  }
  const tip = parseOptionalAmount(mapping.tip && raw[mapping.tip], 'Tip', limits);
  const discount = parseOptionalAmount(mapping.discount && raw[mapping.discount], 'Discount', limits);
  if (tip.error || discount.error) return { error: tip.error || discount.error };
  const paymentMethod = mapping.paymentMethod ? String(raw[mapping.paymentMethod] || '').trim() : '';
  if (paymentMethod.length > limits.maxIdentifierChars) {
    return { error: `Payment method exceeds the ${limits.maxIdentifierChars} character limit` };
  }
  const stated = {
    payment: paymentMethod !== '',
    status: Boolean(mapping.status) && !isBlank(raw[mapping.status]),
    tip: Boolean(mapping.tip) && !isBlank(raw[mapping.tip]),
    discount: Boolean(mapping.discount) && !isBlank(raw[mapping.discount]),
  };
  const statusRaw = stated.status ? String(raw[mapping.status]).trim() : '';
  return {
    itemName, quantity, lineTotal, tip: tip.value, discount: discount.value, paymentMethod,
    status: stated.status ? statusRaw.toLowerCase() : 'approved', statusRaw, stated,
  };
};

const newReceipt = (key, cells) => setSourceRowNumbers({
  receiptId: key.receiptId,
  date: key.date,
  timeKnown: key.timeKnown,
  items: [],
  totals: [],
  tips: [],
  discounts: [],
  paymentMethod: cells.paymentMethod || undefined,
  status: cells.status,
  statusRaw: cells.statusRaw,
  statusStated: cells.stated.status,
  firstLineAt: key.date.getTime(),
  lastLineAt: key.date.getTime(),
  invalidReason: undefined,
}, []);

/** Stated values that disagree, or lines further apart than one ringing-up. Blank cells never conflict. */
const conflictsWithReceipt = (receipt, key, cells) => {
  const at = key.date.getTime();
  return Math.max(receipt.lastLineAt, at) - Math.min(receipt.firstLineAt, at) > RECEIPT_LINE_TIME_TOLERANCE_MS
    || (cells.stated.payment && Boolean(receipt.paymentMethod) && receipt.paymentMethod !== cells.paymentMethod)
    || (cells.stated.status && receipt.statusStated && receipt.status !== cells.status);
};

const addLine = (receipt, key, cells, rowNumber) => {
  const at = key.date.getTime();
  // The sale is dated at its earliest line.
  if (at < receipt.firstLineAt) Object.assign(receipt, { date: key.date, timeKnown: key.timeKnown, firstLineAt: at });
  receipt.lastLineAt = Math.max(receipt.lastLineAt, at);
  if (cells.stated.payment && !receipt.paymentMethod) receipt.paymentMethod = cells.paymentMethod;
  if (cells.stated.status && !receipt.statusStated) {
    Object.assign(receipt, { status: cells.status, statusRaw: cells.statusRaw, statusStated: true });
  }
  if (cells.stated.tip) receipt.tips.push(cells.tip);
  if (cells.stated.discount) receipt.discounts.push(cells.discount);
  receipt[SOURCE_ROW_NUMBERS].push(rowNumber);
  receipt.items.push({ name: cells.itemName, quantity: cells.quantity, lineTotal: cells.lineTotal });
  receipt.totals.push(cells.lineTotal);
};

// A tip or discount repeated on every line is one receipt-level amount; different on each line it is per line.
const receiptAmount = (values) => {
  if (values.length === 0) return 0;
  if (new Set(values).size === 1) return values[0];
  return parseFloat(values.reduce((sum, value) => sum + value, 0).toFixed(2));
};

/** The receipt's total, or why the receipt cannot be imported (every one of its rows is then counted). */
const receiptTotal = (receipt, lineAmounts, limits) => {
  const sourceRows = receipt[SOURCE_ROW_NUMBERS];
  const blankLine = receipt.totals.indexOf(null);
  if (lineAmounts && blankLine >= 0) {
    return {
      rowNumber: sourceRows[blankLine],
      error: `Receipt ${receipt.receiptId} has a line with no amount (row ${sourceRows[blankLine]}). In a file of line amounts every line needs one.`,
    };
  }
  const statedTotals = [...new Set(receipt.totals.filter((total) => total != null).map((total) => Number(total.toFixed(2))))];
  if (!lineAmounts && statedTotals.length !== 1) {
    return {
      rowNumber: sourceRows[0],
      error: `Rows sharing a receipt ID have conflicting receipt totals. Map a column labelled as a line/item amount when each row is a line amount. Receipt ${receipt.receiptId} was dropped, including rows ${sourceRows.join(', ')}`,
    };
  }
  const total = lineAmounts ? receipt.totals.reduce((sum, value) => sum + value, 0) : statedTotals[0];
  if (!Number.isFinite(total) || Math.abs(total) > limits.maxAbsoluteAmount) {
    return { rowNumber: sourceRows[0], error: `Transaction total exceeds the ${limits.maxAbsoluteAmount} amount limit` };
  }
  return { total };
};

const finishReceipt = (receipt, total, lineAmounts, timezone) => {
  const tip = receiptAmount(receipt.tips);
  const discount = receiptAmount(receipt.discounts);
  const hasRefund = receipt.items.some((item) => item.quantity < 0);
  // Magnitudes, as the packed path does: a receipt mixing a sale and a refund can net its quantity to zero, which
  // priced the refund line at 0 and marked it exact (BE-03-T07).
  const absQty = receipt.items.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
  const averageUnitPrice = absQty > 0 ? parseFloat((Math.abs(total) / absQty).toFixed(2)) : 0;
  const receiptPriceSource = unitPriceSource(receipt.items, { tip, discount, hasRefund });
  const {
    totals, invalidReason, tips, discounts, statusStated, timeKnown, firstLineAt, lastLineAt, ...fields
  } = receipt;
  return setSourceRowNumbers({
    ...fields,
    ...temporalFields(receipt.date, timezone, { timeKnown }),
    tip,
    discount,
    total,
    items: receipt.items.map(({ lineTotal, ...item }) => (lineAmounts
      ? {
        ...item,
        // The line's own amount over its own quantity, so Σ price × quantity is the receipt total: a refund line
        // (-1, -30.00) prices at 30, and a discount line (1, -10.00) keeps its negative price. Neither, nor a comped
        // 0.00 line, is a price the till charged, so none is ever learned as one.
        unitPrice: parseFloat((lineTotal / item.quantity).toFixed(2)),
        priceSource: item.quantity < 0 || lineTotal <= 0 ? 'derived' : 'exact',
      }
      : { ...item, unitPrice: averageUnitPrice, priceSource: receiptPriceSource })),
  }, receipt[SOURCE_ROW_NUMBERS]);
};

const RECEIPT_CONFLICT_REASON = 'Rows sharing a receipt ID have conflicting date, time, payment or status values';

/** Puts one row into its receipt, or refuses it with the reason. */
const placeRow = (receipts, raw, rowNumber, { mapping, timezone, context, limits, refuse }) => {
  const key = readReceiptKey(raw, mapping, timezone, context, limits);
  if (key.error) return refuse(rowNumber, key.error, raw);
  const receipt = receipts.get(key.groupKey);
  if (receipt?.invalidReason) {
    // It used to join the dead receipt silently and vanish uncounted, so imported + skipped + errors fell short
    // of the file's rows (BE-03-T09).
    return refuse(rowNumber, `Receipt ${key.receiptId} was already dropped for conflicting values; this row belongs to it.`,
      { receiptId: key.receiptId });
  }
  const cells = readLineCells(raw, mapping, context, limits, Boolean(receipt));
  if (cells.error) return refuse(rowNumber, cells.error, raw);
  if (!receipt) {
    const opened = newReceipt(key, cells);
    receipts.set(key.groupKey, opened);
    return addLine(opened, key, cells, rowNumber);
  }
  if (conflictsWithReceipt(receipt, key, cells)) {
    // The rows already accepted into this receipt are discarded with it, so
    // count them and name them. Counting one error while dropping four rows
    // under-reported the damage: the owner reconciled against the till
    // report, found revenue missing, and the error list gave them no row
    // number to look at.
    const discarded = receipt[SOURCE_ROW_NUMBERS];
    receipt.invalidReason = RECEIPT_CONFLICT_REASON;
    return refuse(rowNumber, `${RECEIPT_CONFLICT_REASON}. Receipt ${key.receiptId} was dropped, including rows ${discarded.join(', ')}`,
      { receiptId: key.receiptId }, 1 + discarded.length);
  }
  if (receipt.items.length >= limits.maxItemsPerTransaction) {
    return refuse(rowNumber, `Transaction exceeds the ${limits.maxItemsPerTransaction} item limit`, raw);
  }
  return addLine(receipt, key, cells, rowNumber);
};

/** The importable receipts, once the file's totals mode is known; a receipt that cannot be is refused whole. */
const finishReceipts = (receipts, lineAmounts, { limits, timezone, refuse }) => {
  const rows = [];
  for (const receipt of receipts.values()) {
    if (receipt.invalidReason) continue;
    const { total, error, rowNumber } = receiptTotal(receipt, lineAmounts, limits);
    if (error) refuse(rowNumber, error, { receiptId: receipt.receiptId }, receipt[SOURCE_ROW_NUMBERS].length);
    else rows.push(finishReceipt(receipt, total, lineAmounts, timezone));
  }
  return rows;
};

const groupLinePerRow = (rawRows, mapping, timezone, context = {}) => {
  const limits = parserLimits();
  const receipts = new Map();
  const rowErrors = [];
  let errors = 0;
  const refuse = (rowNumber, reason, raw, count = 1) => {
    errors += count;
    addRowError(rowErrors, rowNumber, reason, raw);
  };
  const options = { mapping, timezone, context, limits, refuse };
  for (const [index, raw] of rawRows.entries()) {
    const rowNumber = sourceRowNumber(raw, index);
    try {
      placeRow(receipts, raw, rowNumber, options);
    } catch {
      refuse(rowNumber, 'Could not parse row', raw);
    }
  }
  const decision = decideTotalsMode(totalsEvidence(receipts), mapping);
  const rows = finishReceipts(receipts, decision.lineAmounts, options);
  return {
    rows,
    errors,
    rowErrors,
    totalsAreLineAmounts: decision.lineAmounts,
    totalsEvidence: { identical: decision.identical, differing: decision.differing, decidedBy: decision.decidedBy },
  };
};

module.exports = {
  unitPriceSource, groupLinePerRow, RECEIPT_LINE_TIME_TOLERANCE_MS, LINE_AMOUNT_EVIDENCE_SHARE,
};
