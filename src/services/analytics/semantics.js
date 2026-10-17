// What Performance counts. One definition shared by every analytics pipeline and the AI business context, so that
// "transactions" means the same thing on every screen (analytics-ai-5, analytics-ai-24; see the DECISIONS.md entry
// "What Performance counts as a transaction, a day and a tender").
const TOTAL = { $ifNull: ['$total', 0] };

// A sale is an approved row that took money. A refund is an approved row with a negative total: the parser keeps
// "-1 x Flat White" that way on purpose so demand and revenue net off. Zero or missing totals are neither.
const IS_SALE = { $gt: [TOTAL, 0] };
const IS_REFUND = { $lt: [TOTAL, 0] };

const saleCount = { $sum: { $cond: [IS_SALE, 1, 0] } };
const refundCount = { $sum: { $cond: [IS_REFUND, 1, 0] } };
const grossSales = { $sum: { $cond: [IS_SALE, TOTAL, 0] } };
const refundValue = { $sum: { $cond: [IS_REFUND, TOTAL, 0] } }; // negative: money given back
const netRevenue = { $sum: TOTAL };

const isSaleRow = (tx) => Number(tx?.total) > 0;
const isRefundRow = (tx) => Number(tx?.total) < 0;

// Exact, lower-cased, trimmed values. A value on no list is "other": "Cashless card" is not guessed to be cash
// or card, it is reported as other, which is what the substring regexes got wrong.
const TENDER_GROUPS = Object.freeze({
  cash: Object.freeze(['cash', 'kontant', 'cash payment']),
  card: Object.freeze([
    'card', 'cards', 'credit card', 'debit card', 'credit', 'debit', 'card payment', 'card present', 'card_present',
    'card not present', 'manual card', 'tap', 'tap to pay', 'contactless', 'chip', 'swipe', 'visa', 'mastercard',
    'master card', 'maestro', 'amex', 'american express', 'diners', 'diners club', 'apple pay', 'google pay',
    'samsung pay', 'garmin pay',
  ]),
  unknown: Object.freeze(['', 'unknown', 'n/a', 'na', 'none', 'null', '-']),
});

const normaliseTender = (value) => (value == null ? '' : String(value).trim().toLowerCase());

const classifyTender = (value) => {
  const key = normaliseTender(value);
  if (TENDER_GROUPS.cash.includes(key)) return 'cash';
  if (TENDER_GROUPS.card.includes(key)) return 'card';
  if (TENDER_GROUPS.unknown.includes(key)) return 'unknown';
  return 'other';
};

// The same classification inside an aggregation. $trim and $toLower match normaliseTender for the values we store.
const tenderExpression = {
  $let: {
    vars: { method: { $toLower: { $trim: { input: { $ifNull: ['$paymentMethod', ''] } } } } },
    in: {
      $switch: {
        branches: [
          { case: { $in: ['$$method', [...TENDER_GROUPS.cash]] }, then: 'cash' },
          { case: { $in: ['$$method', [...TENDER_GROUPS.card]] }, then: 'card' },
          { case: { $in: ['$$method', [...TENDER_GROUPS.unknown]] }, then: 'unknown' },
        ],
        default: 'other',
      },
    },
  },
};

module.exports = {
  IS_SALE,
  IS_REFUND,
  saleCount,
  refundCount,
  grossSales,
  refundValue,
  netRevenue,
  isSaleRow,
  isRefundRow,
  TENDER_GROUPS,
  classifyTender,
  tenderExpression,
};
