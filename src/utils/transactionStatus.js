/**
 * What a POS export's Status column means.
 *
 * The importer used to compare against the single literal 'approved', so a till
 * that writes "Completed", "Paid" or "Successful" had every row counted as
 * declined and silently skipped — the upload finished reporting "0 imported,
 * N skipped, 0 errors", which reads as a broken importer rather than a
 * vocabulary mismatch. Yoco writes "Approved"; nothing guarantees the next
 * vendor does.
 *
 * An unrecognised value is still declined — importing a row whose status we do
 * not understand would be a guess about money — but it is flagged so the caller
 * can tell the operator which word it did not know, instead of saying nothing.
 */

// An empty Status column means the export does not track status at all: every
// row in it is a sale. That is the historical default and stays.
const APPROVED = new Set([
  'approved', 'approve',
  'complete', 'completed',
  'paid',
  'success', 'successful',
  'settled',
  'captured',
  'ok',
]);

const DECLINED = new Set([
  'declined', 'decline',
  'refunded', 'refund',
  'failed', 'failure',
  'void', 'voided',
  'cancelled', 'canceled',
  'reversed', 'chargeback',
  'error', 'aborted', 'expired', 'pending',
]);

// A partly refunded sale is still a sale: the customer kept part of it. Declining it dropped the revenue and the
// items they kept. See DECISIONS D-021 (BE-03-T07).
const PARTIALLY_REFUNDED = new Set(['partially refunded', 'partial refund', 'partially_refunded', 'part refunded', 'partly refunded']);
const REFUND = new Set(['refunded', 'refund']);

// Why a row was not imported, keyed into Upload.stats.skippedByReason. skipped must always equal their sum.
const SKIP_REASON_STATUS = 'status_not_approved';
const SKIP_REASON_DUPLICATE = 'duplicate'; // the cafe already holds this sale (another upload, or older data)
const SKIP_REASON_IN_FILE_DUPLICATE = 'in_file_duplicate'; // the same sale appears earlier in this file
const SKIP_REASON_REFUND_NETTED = 'refund_netted'; // a refund row netted into the sale it refunds (BE-03-T07)

const normaliseTransactionStatus = (raw) => {
  const key = String(raw ?? '').trim().toLowerCase();
  if (key === '') return { status: 'approved', recognised: true };
  if (APPROVED.has(key)) return { status: 'approved', recognised: true };
  if (PARTIALLY_REFUNDED.has(key)) return { status: 'approved', recognised: true, partialRefund: true };
  if (DECLINED.has(key)) return { status: 'declined', recognised: true };
  return { status: 'declined', recognised: false };
};

/** A row that is itself a refund (not a sale that was partly refunded). */
const isRefundStatus = (raw) => REFUND.has(String(raw ?? '').trim().toLowerCase());

module.exports = {
  normaliseTransactionStatus, isRefundStatus, APPROVED, DECLINED, PARTIALLY_REFUNDED,
  SKIP_REASON_STATUS, SKIP_REASON_DUPLICATE, SKIP_REASON_IN_FILE_DUPLICATE, SKIP_REASON_REFUND_NETTED,
};
