// Packed items: the linear scanner over a "2 x Latte, 1 x Muffin" cell (BE-01-T05) and the packed-row builder.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { parserLimits } = require('./limits');
const { setSourceRowNumbers, receiptIdError } = require('./rowErrors');
const { parseBoundedAmount, parseOptionalAmount } = require('./numbers');
const { parseDate, transactionDateError, temporalFields } = require('./dates');
const { unitPriceSource } = require('./lineItems');

// Quantities may be fractional: cafes selling by weight export rows like
// "0.35 x Cheese Wheel". Matching digits only made the engine skip past the
// "0." and read the decimal part as the whole quantity, turning 0.35 into 35.
// A comma decimal is the same trap wearing South African clothes -- "1,5 x
// Biltong" was read as five units, a 3.3x overstatement of the weight sold.
//
// The leading sign matters just as much. A till exports a refund as "-1 x Flat
// White"; without the sign the engine stepped over the minus and recorded a
// SALE of one, so a refund moved demand two units the wrong way and the stored
// row contradicted itself -- total -38 against quantity +1. The sign also has to
// appear in the separator lookahead, or "1 x Flat White,-1 x Flat White" is not
// recognised as two lines at all and collapses into one item whose name is the
// rest of the string.
const PACKED_QUANTITY = String.raw`-?\d+(?:[.,]\d+)?`;
// Plenty of tills print U+00D7 rather than an ASCII x, and some print a capital
// X. The sign used to stay glued to the item name, so "Flat White" and
// "× Flat White" were two different products splitting one history in half.
const PACKED_MARKER = String.raw`\s+[x×]\s+`;
// The name may not cross a newline, and a newline separates basket lines. A
// till that wraps its basket inside one quoted cell had only its LAST line
// read: `.` never matches a newline and `$` is end-of-string, so the earlier
// items vanished with no error and the survivor absorbed the whole basket
// total as an "exact" price.
// The packed grammar, `-?\d+(?:[.,]\d+)?\s+[x×]\s+NAME` repeated, where NAME
// runs to the first `,` `;` or newline that is followed by another quantity
// and marker, or to the end of the cell, and never crosses a newline. It used
// to be one global regex, `(QTY)MARKER([^\n]+?)(?:[,;\n](?=\s*QTY MARKER)|$)`,
// whose lazy NAME re-scanned to the next newline from every digit: a
// 10,000-character cell cost tens of millions of steps and an XLSX could repeat
// it on every row (parsing-2). This reads it in one pass with three precomputed
// look-up arrays, and returns exactly what that regex returned.
const CODE_NEWLINE = 10;
const CODE_COMMA = 44;
const CODE_MINUS = 45;
const CODE_DOT = 46;
const CODE_SEMICOLON = 59;
const MARKER_CODES = new Set([120, 88, 215]); // x, X, ×

const isDigitCode = (code) => code >= 48 && code <= 57;

// Exactly the code units JavaScript's \s matches.
const isJsWhitespace = (code) =>
  (code >= 9 && code <= 13) || code === 32 || code === 160 || code === 5760
  || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239
  || code === 8287 || code === 12288 || code === 65279;

// Reused between calls: parsePackedItems is synchronous and never re-entered,
// and four fresh arrays per 10,000-character cell were 160 KB of garbage per
// row, 1.6 GB across a 10,000-row file. Every slot in [0, n] is rewritten on
// each call, so nothing stale is ever read.
let packedScratch = new Int32Array(4 * 1024);

const buildPackedIndex = (text) => {
  const n = text.length;
  const size = n + 1;
  if (packedScratch.length < size * 4) packedScratch = new Int32Array(size * 4);
  const digitEnd = packedScratch.subarray(0, size); // first non-digit at or after i
  const spaceEnd = packedScratch.subarray(size, size * 2); // first non-whitespace at or after i
  const newlineAt = packedScratch.subarray(size * 2, size * 3); // first newline at or after i (n if none)
  const nextTerminator = packedScratch.subarray(size * 3, size * 4);
  digitEnd[n] = n;
  spaceEnd[n] = n;
  newlineAt[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    digitEnd[i] = isDigitCode(code) ? digitEnd[i + 1] : i;
    spaceEnd[i] = isJsWhitespace(code) ? spaceEnd[i + 1] : i;
    newlineAt[i] = code === CODE_NEWLINE ? i : newlineAt[i + 1];
  }
  return { n, digitEnd, spaceEnd, newlineAt, nextTerminator };
};

// Where `-?\d+(?:[.,]\d+)?\s+[x×]\s+` matches from `start`: the end of the
// quantity and the start of the name. Constant time with the index.
const packedHeadAt = (text, index, start) => {
  const { n, digitEnd, spaceEnd } = index;
  let cursor = start;
  if (cursor < n && text.charCodeAt(cursor) === CODE_MINUS) cursor += 1;
  if (cursor >= n || !isDigitCode(text.charCodeAt(cursor))) return null;
  cursor = digitEnd[cursor];
  const decimal = cursor < n ? text.charCodeAt(cursor) : -1;
  if ((decimal === CODE_DOT || decimal === CODE_COMMA) && cursor + 1 < n && isDigitCode(text.charCodeAt(cursor + 1))) {
    cursor = digitEnd[cursor + 1];
  }
  const qtyEnd = cursor;
  const markerAt = spaceEnd[qtyEnd];
  if (markerAt === qtyEnd || markerAt >= n || !MARKER_CODES.has(text.charCodeAt(markerAt))) return null;
  const nameStart = spaceEnd[markerAt + 1];
  if (nameStart === markerAt + 1) return null;
  return { qtyEnd, nameStart };
};

// nextTerminator[i]: the first position at or after i where a name may end:
// a separator followed by another quantity and marker, or the end of the cell.
const buildPackedTerminators = (text, index) => {
  const { n, spaceEnd, nextTerminator } = index;
  nextTerminator[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    const separator = code === CODE_COMMA || code === CODE_SEMICOLON || code === CODE_NEWLINE;
    nextTerminator[i] = separator && packedHeadAt(text, index, spaceEnd[i + 1]) ? i : nextTerminator[i + 1];
  }
  return nextTerminator;
};

const scanPackedItems = (text) => {
  const index = buildPackedIndex(text);
  const nextTerminator = buildPackedTerminators(text, index);
  const items = [];
  let start = 0;
  while (start < index.n) {
    const code = text.charCodeAt(start);
    const head = code === CODE_MINUS || isDigitCode(code) ? packedHeadAt(text, index, start) : null;
    if (head && head.nameStart < index.n) {
      const end = nextTerminator[head.nameStart + 1];
      // The name may not cross a newline; the newline can only be its terminator.
      if (end <= index.newlineAt[head.nameStart]) {
        const quantity = packedQuantity(text.slice(start, head.qtyEnd));
        const name = text.slice(head.nameStart, end).trim();
        if (name && quantity != null) items.push({ name, quantity });
        start = end < index.n ? end + 1 : index.n;
        continue;
      }
    }
    // Every later start inside this digit run reaches the same quantity end,
    // the same marker check and the same name start, so it fails the same way
    // (the regex's backtracked matches only ever produced whitespace-only
    // names, which were dropped): skip the run. A minus steps on by one.
    start = isDigitCode(code) ? index.digitEnd[start] : start + 1;
  }
  return items;
};
// The marker is mandatory here. With `x` optional, any description starting
// with a number was read as a quantity: "500 Still Water" became 500 units of
// "Still Water", and "2 Minute Noodles" two units of "Minute Noodles".
const LOOSE_PACKED_ITEM_RE = new RegExp(`^(${PACKED_QUANTITY})\\s*[x\\u00d7]\\s+(.+)$`, 'i');

const packedQuantity = (raw) => {
  const quantity = parseFloat(String(raw).replace(',', '.'));
  return Number.isFinite(quantity) && quantity !== 0 ? quantity : null;
};

/**
 * Parses Yoco-style "1 x Flat White,2 x Brownie" item strings.
 * @param {string} str
 * @returns {{name: string, quantity: number}[]}
 */
const parsePackedItems = (str) => {
  if (!str) return [];
  const items = scanPackedItems(String(str));
  if (items.length > 0) return items;

  return String(str)
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const loose = part.match(LOOSE_PACKED_ITEM_RE);
      if (loose) {
        return { name: loose[2].trim(), quantity: packedQuantity(loose[1]) };
      }
      // A part with no letters in it is a stray field the export left behind,
      // not a product. Emitting it created menu entries literally named "2".
      if (!/\p{L}/u.test(part)) return null;
      return { name: part, quantity: 1 };
    })
    .filter((item) => item && item.name && item.quantity != null && item.quantity !== 0);
};

const buildPackedRow = (raw, mapping, rowNumber, timezone) => {
  const limits = parserLimits();
  const date = parseDate(raw[mapping.date], mapping.time && raw[mapping.time], timezone);
  if (!date) return { error: 'Could not parse date or time' };
  const dateError = transactionDateError(date, timezone);
  if (dateError) return { error: dateError };
  const items = parsePackedItems(raw[mapping.items] || '');
  if (items.length === 0) return { error: 'Missing or invalid items' };
  if (items.length > limits.maxItemsPerTransaction) {
    return { error: `Transaction exceeds the ${limits.maxItemsPerTransaction} item limit` };
  }
  if (items.some((item) => item.name.length > limits.maxItemNameChars)) {
    return { error: `Item name exceeds the ${limits.maxItemNameChars} character limit` };
  }
  // Quantities may legitimately be fractional -- a deli sells 0.35 of a cheese
  // wheel -- so require a finite non-zero number rather than a whole one, and
  // report the reason that actually applies instead of blaming the upper limit
  // for a sub-unit weight. Negative is legitimate too: it is a refund, and the
  // bound applies to how big the line is, not which way it points.
  const badQuantity = items.find((item) => !Number.isFinite(item.quantity) || item.quantity === 0
    || Math.abs(item.quantity) > limits.maxItemQuantity);
  if (badQuantity) {
    return {
      error: Math.abs(badQuantity.quantity) > limits.maxItemQuantity
        ? `Item quantity exceeds the ${limits.maxItemQuantity} limit`
        : 'Item quantity must be a non-zero number',
    };
  }
  const receiptId = mapping.receiptId ? String(raw[mapping.receiptId] || '').trim() : '';
  const receiptError = receiptId ? receiptIdError(receiptId, limits) : null;
  if (receiptError) return { error: receiptError };
  const paymentMethod = mapping.paymentMethod
    ? String(raw[mapping.paymentMethod] || '').trim()
    : '';
  if (paymentMethod.length > limits.maxIdentifierChars) {
    return { error: `Payment method exceeds the ${limits.maxIdentifierChars} character limit` };
  }
  const total = parseBoundedAmount(raw[mapping.total], limits);
  if (total === null) {
    return { error: `Invalid transaction total or amount exceeds ${limits.maxAbsoluteAmount}` };
  }
  const parsedTip = parseOptionalAmount(mapping.tip && raw[mapping.tip], 'Tip', limits);
  if (parsedTip.error) return { error: parsedTip.error };
  const parsedDiscount = parseOptionalAmount(
    mapping.discount && raw[mapping.discount],
    'Discount',
    limits
  );
  if (parsedDiscount.error) return { error: parsedDiscount.error };
  const tip = parsedTip.value;
  const discount = parsedDiscount.value;
  // Price is derived from magnitudes, not the signed sum. A refund receipt has a
  // negative total AND a negative quantity, and dividing one by the other would
  // give a positive price by accident; a receipt mixing a sale and a refund can
  // sum to zero and divide by nothing at all. Absolute values keep the unit price
  // the positive menu price it should be, and leave the sign where it belongs --
  // on the quantity, which is what every downstream aggregate nets.
  const absQty = items.reduce((sum, item) => sum + Math.abs(item.quantity), 0);
  if (absQty <= 0) return { error: 'Invalid item quantity' };
  const unitPrice = parseFloat((Math.abs(total) / absQty).toFixed(2));
  const hasRefund = items.some((item) => item.quantity < 0);
  const priceSource = unitPriceSource(items, { tip, discount, hasRefund });
  const row = {
    receiptId: receiptId || undefined,
    date,
    ...temporalFields(date, timezone),
    items: items.map((i) => ({ ...i, unitPrice, priceSource })),
    total,
    tip,
    discount,
    paymentMethod: paymentMethod || undefined,
    status: mapping.status ? String(raw[mapping.status] || 'approved').trim().toLowerCase() : 'approved',
    // The operator's own wording, kept so a skip reason can quote their file
    // rather than a lowercased version of it.
    statusRaw: mapping.status ? String(raw[mapping.status] || '').trim() : '',
  };
  return { row: setSourceRowNumbers(row, [rowNumber]) };
};

module.exports = {
  parsePackedItems, buildPackedRow,
};
