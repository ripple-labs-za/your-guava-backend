// Partially refunded sales and the refund rows that belong to them (BE-03-T07, DECISIONS D-021).
const { sourceRowNumber, addRowError, setSourceRowNumbers, SOURCE_ROW_NUMBERS } = require('./rowErrors');
const { normaliseTransactionStatus, isRefundStatus } = require('../../utils/transactionStatus');

const money = (value) => Number(value).toFixed(2);
const saleKey = (row) => `${row.receiptId}|${row.dateKey}`;
const isPartialRefund = (row) => Boolean(normaliseTransactionStatus(row.status).partialRefund);
const notice = (rowErrors, row, reason) =>
  addRowError(rowErrors, sourceRowNumber(row), reason, row.receiptId ? { receiptId: row.receiptId } : {});

const netInto = (sale, refunds, refunded) => setSourceRowNumbers({
  ...sale,
  total: parseFloat((sale.total - refunded).toFixed(2)),
  items: [
    ...sale.items,
    ...refunds.flatMap((refund) => refund.items.map((item) => ({ ...item, quantity: -Math.abs(item.quantity) }))),
  ].map((item) => ({ ...item, priceSource: 'derived' })),
}, [...(sale[SOURCE_ROW_NUMBERS] || []), ...refunds.flatMap((refund) => refund[SOURCE_ROW_NUMBERS] || [])]);

/**
 * A packed export may mark a sale "Partially Refunded" and carry the refund as its own "Refunded" row with the same
 * receipt number on the same day. The refund is netted into the sale, which then carries what the cafe kept.
 *
 * Only an unambiguous pair is netted: exactly one partially refunded sale under that number that day, and refunds no
 * larger than the sale. Otherwise nothing is netted, the sale imports at its exported amount, its refund rows are
 * skipped by status as before, and a notice says why (a refund larger than its sale is D-021's revisit case: the till
 * may write the retained amount on the sale row, or the refund belongs to another receipt; -R12 is right in neither).
 */
const netPartialRefunds = (rows, rowErrors) => {
  const partialCount = new Map();
  for (const row of rows) {
    if (row.receiptId && isPartialRefund(row)) partialCount.set(saleKey(row), (partialCount.get(saleKey(row)) || 0) + 1);
  }
  const refundsByKey = new Map();
  const refundedReceipts = new Set();
  for (const row of rows) {
    if (!row.receiptId || !isRefundStatus(row.status)) continue;
    refundedReceipts.add(row.receiptId);
    refundsByKey.set(saleKey(row), [...(refundsByKey.get(saleKey(row)) || []), row]);
  }

  const nettable = new Map(); // saleKey -> refunds to absorb
  for (const row of rows) {
    if (!row.receiptId || !isPartialRefund(row) || partialCount.get(saleKey(row)) !== 1) continue;
    const refunds = refundsByKey.get(saleKey(row)) || [];
    const refunded = refunds.reduce((sum, refund) => sum + Math.abs(refund.total), 0);
    if (refunds.length > 0 && refunded <= Math.abs(row.total)) nettable.set(saleKey(row), { refunds, refunded });
  }
  const absorbed = new Set([...nettable.values()].flatMap(({ refunds }) => refunds));

  const result = [];
  for (const row of rows) {
    if (absorbed.has(row)) continue;
    if (!isPartialRefund(row)) {
      result.push(row);
      continue;
    }
    const full = `R${money(row.total)}`;
    if (!row.receiptId) {
      notice(rowErrors, row, `Row ${sourceRowNumber(row)} is marked Partially Refunded but has no receipt number to match a refund `
        + `row to, so its full ${full} was imported.`);
      result.push(row);
      continue;
    }
    const netting = nettable.get(saleKey(row));
    if (netting) {
      result.push(netInto(row, netting.refunds, netting.refunded));
      continue;
    }
    const sameDay = refundsByKey.get(saleKey(row)) || [];
    if (partialCount.get(saleKey(row)) > 1) {
      notice(rowErrors, row, `Receipt ${row.receiptId} is marked Partially Refunded on more than one sale that day, so its refund `
        + 'rows could not be matched to one sale; each was imported at its full amount.');
    } else if (sameDay.length > 0) {
      const refunded = sameDay.reduce((sum, refund) => sum + Math.abs(refund.total), 0);
      notice(rowErrors, row, `Receipt ${row.receiptId} refunds R${money(refunded)}, more than its sale of ${full}, so the two were `
        + `not netted and the sale was imported at its full ${full}. Check the till for a refund recorded against the wrong receipt.`);
    } else if (refundedReceipts.has(row.receiptId)) {
      notice(rowErrors, row, `Receipt ${row.receiptId} is marked Partially Refunded, but its refund row is dated another day, so it `
        + `was not netted and its full ${full} was imported.`);
    } else {
      notice(rowErrors, row, `Receipt ${row.receiptId} is marked Partially Refunded, but the file has no refund row for it, so its `
        + `full ${full} was imported.`);
    }
    result.push(row);
  }
  return { rows: result, nettedRefundRows: absorbed.size };
};

/**
 * Line-per-row receipts carry their refund as a negative line inside the receipt, so nothing needs netting. A receipt
 * marked partially refunded with no such line imports at its exported amount; D-021 says that must be visible.
 */
const noteUnitemisedPartialRefunds = (rows, rowErrors) => {
  for (const row of rows) {
    if (!isPartialRefund(row) || row.items.some((item) => item.quantity < 0)) continue;
    notice(rowErrors, row, `Receipt ${row.receiptId} is marked Partially Refunded, but the file has no refund line for it, so its `
      + `full R${money(row.total)} was imported.`);
  }
  return rows;
};

module.exports = { netPartialRefunds, noteUnitemisedPartialRefunds };
