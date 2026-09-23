// Source row numbers and the bounded per-row error list an import reports back.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.

const SOURCE_ROW_NUMBERS = '__sourceRowNumbers';
const MAX_ROW_ERRORS = 50;
const MAX_ROW_ERROR_COLUMNS = 12;
const MAX_ROW_ERROR_VALUE_LENGTH = 160;

const sourceRowNumber = (raw, fallbackIndex = 0) =>
  Array.isArray(raw?.[SOURCE_ROW_NUMBERS]) && raw[SOURCE_ROW_NUMBERS][0]
    ? raw[SOURCE_ROW_NUMBERS][0]
    : fallbackIndex + 2;

const setSourceRowNumbers = (row, rowNumbers) => {
  Object.defineProperty(row, SOURCE_ROW_NUMBERS, {
    value: [...rowNumbers],
    enumerable: false,
    configurable: true,
  });
  return row;
};

const serialiseRowErrorValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value == null) return '';

  const stringValue = typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);

  return stringValue.length > MAX_ROW_ERROR_VALUE_LENGTH
    ? `${stringValue.slice(0, MAX_ROW_ERROR_VALUE_LENGTH)}...`
    : stringValue;
};

const serialiseRowErrorRaw = (raw) =>
  Object.fromEntries(
    Object.entries(raw || {})
      .slice(0, MAX_ROW_ERROR_COLUMNS)
      .map(([key, value]) => [key, serialiseRowErrorValue(value)])
  );

const addRowError = (rowErrors, rowNumber, reason, raw) => {
  if (rowErrors.length >= MAX_ROW_ERRORS) return;
  rowErrors.push({
    rowNumber,
    reason,
    raw: serialiseRowErrorRaw(raw),
  });
};

// "20260914000123" saved through Excel comes back as "2.02609E+16": different sales now share one number, and
// identity-by-receipt would merge them. Refuse the row and say how to fix the export.
const EXCEL_SCIENTIFIC_RE = /^[+-]?\d(?:[.,]\d+)?e[+-]?\d+$/i;

/** Why a receipt number cannot identify a sale, or null. Shared by the packed and line-per-row builders. */
const receiptIdError = (receiptId, limits) => {
  if (receiptId.length > limits.maxIdentifierChars) {
    return `Receipt ID exceeds the ${limits.maxIdentifierChars} character limit`;
  }
  if (EXCEL_SCIENTIFIC_RE.test(receiptId)) {
    return `Receipt number "${receiptId}" was shortened by Excel into scientific notation, so different sales share it. `
      + 'Export again from the till, or format the receipt column as Text in Excel before saving.';
  }
  return null;
};

module.exports = {
  SOURCE_ROW_NUMBERS, MAX_ROW_ERRORS, sourceRowNumber, setSourceRowNumbers, addRowError, receiptIdError,
};
