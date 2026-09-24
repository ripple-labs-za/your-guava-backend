// Money and quantity cells: signs, currency symbols, decimal commas and the configured bounds.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { parserLimits } = require('./limits');

const parseCleanNumber = (raw, { decimalMark } = {}) => {
  if (raw == null || raw === '') return { valid: false, value: 0 };
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { valid: true, value: raw }
      : { valid: false, value: 0 };
  }

  let value = String(raw).trim();
  if (/\d[eE][+-]?\d/.test(value)) return { valid: false, value: 0 };

  // Judge the sign markers only after currency symbols and spacing are gone.
  // The parenthesis test used to run on the raw string, so "R(150.00)" read as
  // a positive 150 while "(150.00)" correctly read as -150; and every minus
  // after the first character was stripped outright, so the trailing-minus
  // convention older accounting exports use -- "45.00-" -- lost its sign
  // entirely. Either way a refund was booked as revenue and the day's takings
  // overstated by twice it.
  value = value.replace(/\s+/g, '').replace(/[^\d(),.-]/g, '');
  const negative = /^\(.+\)$/.test(value) || /^-/.test(value) || /-$/.test(value);
  value = value.replace(/[()-]/g, '');

  if (!value || value === '.' || value === ',') {
    return { valid: false, value: 0 };
  }

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    value = lastComma > lastDot
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const commaCount = (value.match(/,/g) || []).length;
    const decimalDigits = value.length - lastComma - 1;
    // "0,350" in a column the file shows uses decimal commas is 0.35, not 350 (BE-03-T07); without that evidence a
    // comma before three digits stays a thousands separator.
    const isDecimalComma = commaCount === 1 && decimalDigits > 0
      && (decimalMark === ',' || (decimalMark !== '.' && decimalDigits <= 2));
    value = isDecimalComma ? value.replace(',', '.') : value.replace(/,/g, '');
  }

  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return { valid: false, value: 0 };
  return {
    valid: true,
    value: negative ? -Math.abs(parsed) : parsed,
  };
};

const parseBoundedAmount = (raw, limits = parserLimits()) => {
  const parsed = parseCleanNumber(raw);
  if (!parsed.valid || Math.abs(parsed.value) > limits.maxAbsoluteAmount) return null;
  return parsed.value;
};

/**
 * Reads an optional money column -- Tip, Discount -- where a blank cell means
 * "none".
 *
 * Tills routinely leave these columns empty on a cash sale rather than writing
 * 0.0. A blank cell was read as an unparseable amount and the whole row was
 * discarded, so a till with that habit lost every cash transaction it ever
 * exported, and the owner was told the amount had exceeded ten million. Absent
 * is not malformed: only a cell with something in it can fail to parse.
 *
 * Returns `{ value }` or `{ error }`, where the error names which column failed
 * and whether it was unreadable or simply too large -- an operator can act on
 * "Tip is not a valid amount" and cannot act on the two fused together.
 */
const parseOptionalAmount = (raw, label, limits) => {
  if (raw == null || String(raw).trim() === '') return { value: 0 };
  const parsed = parseCleanNumber(raw);
  if (!parsed.valid) return { error: `${label} is not a valid amount` };
  if (Math.abs(parsed.value) > limits.maxAbsoluteAmount) {
    return { error: `${label} exceeds the ${limits.maxAbsoluteAmount} amount limit` };
  }
  return { value: parsed.value };
};

const parseQuantity = (raw, limits = parserLimits(), options = {}) => {
  const parsed = parseCleanNumber(raw, options);
  // Truncating discarded weight-based quantities entirely: 0.35 became 0 and the
  // row was rejected as invalid. Keep the value the till actually recorded.
  const quantity = parsed.value;
  // Negative quantities are refunds and must survive parsing for the same reason
  // they do in packed mode -- silently dropping the sign turns a return into a
  // sale. Zero is still meaningless, and the bound applies to the magnitude.
  return parsed.valid && Number.isFinite(quantity) &&
    quantity !== 0 && Math.abs(quantity) <= limits.maxItemQuantity
    ? quantity
    : null;
};

/**
 * The decimal mark a quantity column uses, judged on the whole column, not one cell. "0,350" can only be a decimal comma
 * (no thousands group starts with 0), "1,5" and "2,25" can only be decimal, "1.250,5" is European. A column of nothing
 * but "1,250"-shaped values cannot tell; a ';'-separated file, the South African Excel default, settles it as commas.
 */
const inferDecimalMark = (values, { csvSeparator } = {}) => {
  let comma = false;
  let dot = false;
  for (const raw of values) {
    if (raw == null || typeof raw === 'number') continue;
    const value = String(raw).trim().replace(/^[-+(]+|[)-]+$/g, '');
    if (/^0,\d+$/.test(value) || /^\d+,(\d{1,2}|\d{4,})$/.test(value) || /^\d{1,3}(\.\d{3})+,\d+$/.test(value)) comma = true;
    else if (/^0\.\d+$/.test(value) || /^\d+\.(\d{1,2}|\d{4,})$/.test(value) || /^\d{1,3}(,\d{3})+\.\d+$/.test(value)) dot = true;
    if (comma && dot) return null; // a contradictory column keeps the per-cell rule
  }
  if (comma) return ',';
  if (dot) return '.';
  return csvSeparator === ';' ? ',' : null;
};

module.exports = {
  parseBoundedAmount, parseOptionalAmount, parseQuantity, inferDecimalMark,
};
