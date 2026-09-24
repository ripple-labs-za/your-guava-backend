// Header and cell normalisation, header de-duplication and the required-field mapping check.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { parserLimits } = require('./limits');
const { SOURCE_ROW_NUMBERS } = require('./rowErrors');

const REQUIRED_FIELDS = ['date', 'items', 'total'];
const UNNAMED_COLUMN_RE = /^_(\d+)$/;

// A column name, not a cell. Clipped before anything reads it, so no check
// downstream (the PII guard, the POS preset, the AI prompt) sees a runaway line.
const MAX_HEADER_CHARS = 200;

const requiredFieldsForMode = (itemsMode = 'packed') =>
  itemsMode === 'line-per-row'
    ? [...REQUIRED_FIELDS, 'receiptId']
    : REQUIRED_FIELDS;

const normaliseHeader = (header, index = 0) => {
  // One pair of surrounding quotes goes too: a quoted first header behind a BOM reached here as "Receipt" (BE-03-T08).
  const value = String(header ?? '').replace(/^\uFEFF/, '').trim().replace(/^"(.*)"$/s, '$1').trim()
    .slice(0, MAX_HEADER_CHARS);
  return value || `Column ${index + 1}`;
};

/**
 * POS exports do repeat column names -- "Amount" for gross and net, "Total" for
 * the line and the receipt, "Date" for the sale and the settlement. Collapsed
 * into one key the last column silently won, so the owner mapped a column they
 * had never seen and the money came out wrong with no warning at any stage.
 *
 * Suffixing repeats keeps every column addressable, and because the preview and
 * the parse run the same deterministic pass, the column the owner picks is the
 * column that is read.
 */
const headerDeduper = () => {
  const seen = new Map();
  return (header, index) => {
    const base = normaliseHeader(header, index);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return occurrence === 1 ? base : `${base} (${occurrence})`;
  };
};

// One runaway cell -- a pasted note, an escaped-quote bug in the till's own
// export that ran several lines together -- used to throw out of the parser and
// abort a 10,000-row import, naming neither the row nor the column, and often
// in a column the owner never intended to import. Clip it instead: the mapped
// fields have their own length bounds, so a truncated item name or receipt ID
// still becomes an honest row error while the rest of the file lands.
// A reader passes the limits it already holds: parserLimits() reads the
// environment about fifteen times, and a 128 KB line of separators is 131
// thousand cells.
const normaliseCell = (value, limits = parserLimits()) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > limits.maxCellChars ? trimmed.slice(0, limits.maxCellChars) : trimmed;
};

const normaliseRow = (row) => {
  const normalised = {};
  Object.entries(row || {}).forEach(([key, value], index) => {
    const normalisedKey = UNNAMED_COLUMN_RE.test(key) ? key : normaliseHeader(key, index);
    normalised[normalisedKey] = normaliseCell(value);
  });
  if (row?.[SOURCE_ROW_NUMBERS]) {
    Object.defineProperty(normalised, SOURCE_ROW_NUMBERS, {
      value: row[SOURCE_ROW_NUMBERS],
      enumerable: false,
      configurable: true,
    });
  }
  return normalised;
};

const normaliseRows = (rows) => rows.map(normaliseRow);

/** The ten fields a column mapping may name, in one place (the uploads code and the saved mapping use it). */
const COLUMN_MAPPING_FIELDS = Object.freeze([
  'receiptId', 'date', 'time', 'items', 'total', 'tip', 'discount', 'paymentMethod', 'status', 'quantity',
]);

/** Only the mapping fields of `source` that name a column, dropping provenance, itemsMode and blanks. */
const pickColumnMapping = (source = {}) => Object.fromEntries(
  COLUMN_MAPPING_FIELDS
    .filter((field) => typeof source?.[field] === 'string' && source[field] !== '')
    .map((field) => [field, source[field]])
);

const validateMapping = (mapping, itemsMode = 'packed') => {
  const missing = requiredFieldsForMode(itemsMode).filter((f) => !mapping?.[f]);
  if (missing.length > 0) {
    throw new Error(`Mapping missing required fields: ${missing.join(', ')}`);
  }
};

module.exports = {
  REQUIRED_FIELDS, UNNAMED_COLUMN_RE, MAX_HEADER_CHARS, requiredFieldsForMode, normaliseHeader, headerDeduper, normaliseCell,
  normaliseRow, normaliseRows, validateMapping, COLUMN_MAPPING_FIELDS, pickColumnMapping,
};
