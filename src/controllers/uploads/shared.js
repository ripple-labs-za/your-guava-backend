// Constants and helpers every uploads handler shares: mapping validation, importability checks, response shapes.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const { sha256Hex } = require('../../utils/authPrimitives');
const parser = require('../../services/parser.service');
const Upload = require('../../models/Upload.model');
const { getCafeTimezone } = require('../../utils/timezone');
const { normaliseTransactionStatus } = require('../../utils/transactionStatus');


const MAX_LIST_PAGE = 10000;
const STORAGE_CLEANUP_PENDING = 'Stored file cleanup pending; background cleanup will retry.';
const ABANDONED_CLEANUP_CLAIM = 'Removing an abandoned unconfirmed upload.';
const SEVERE_PARTIAL_MIN_ERRORS = 10;
const SEVERE_PARTIAL_ERROR_RATIO = 0.25;
const CONFIRMATION_KEY_MAX_LENGTH = 160;


const confirmationMappingHash = (columnMapping, itemsMode) => sha256Hex(JSON.stringify({
  itemsMode,
  columnMapping: Object.fromEntries(
    parser.COLUMN_MAPPING_FIELDS.map((field) => [field, columnMapping?.[field] || null])
  ),
}));

const sanitizeRowErrors = (rowErrors) =>
  (Array.isArray(rowErrors) ? rowErrors : []).slice(0, parser.MAX_ROW_ERRORS).map((rowError) => ({
    rowNumber: rowError?.rowNumber,
    reason: String(rowError?.reason || 'Could not import row').slice(0, 500),
  }));

const confirmationResponse = (upload, { replayed = false } = {}) => ({
  success: true,
  uploadId: upload._id,
  stats: upload.stats,
  dateRange: upload.dateRange,
  rowErrors: sanitizeRowErrors(upload.rowErrors),
  maintenance: upload.maintenance || { status: 'queued' },
  overlap: upload.overlap || { rows: 0, uploads: [] },
  replayed,
});

const MAX_OVERLAP_UPLOADS = 20;

/** Names the uploads that already held the sales this file skipped (BE-03-T03), largest first, at most 20. */
const describeOverlap = async (duplicatesByUpload = [], { cafeId, session }) => {
  const ids = duplicatesByUpload.map((entry) => entry.uploadId).filter(Boolean);
  let query = Upload.find({ _id: { $in: ids }, cafeId }).select('fileName');
  if (session) query = query.session(session);
  const names = new Map((await query.lean()).map((upload) => [String(upload._id), upload.fileName]));
  return {
    rows: duplicatesByUpload.reduce((sum, entry) => sum + entry.rows, 0),
    uploads: duplicatesByUpload.slice(0, MAX_OVERLAP_UPLOADS).map(({ uploadId, rows }) => ({
      uploadId: uploadId || null,
      fileName: uploadId ? names.get(uploadId) || null : null,
      rows,
    })),
  };
};

// One definition, in services/parser/limits.js; lease, jobs and sweeper take it from here.
const { boundedInteger } = parser;

// The upload-level mapping check (items mode, required fields, columns present in the file). The
// parser's own validateMapping checks required fields only; this one was a second function of that name.
const validateUploadMapping = (upload, columnMapping, itemsMode) => {
  const mode = itemsMode || 'packed';
  if (!parser.VALID_ITEMS_MODES.has(mode)) return `Invalid itemsMode: ${itemsMode}`;
  const missing = parser.requiredFieldsForMode(mode).filter((f) => !columnMapping?.[f]);
  if (missing.length > 0) {
    return `Missing required mapping: ${missing.join(', ')}`;
  }

  const headers = Array.isArray(upload?.headers) ? upload.headers : [];
  if (headers.length > 0) {
    const invalid = Object.entries(columnMapping || {})
      .filter(([, value]) => value != null && value !== '' && (typeof value !== 'string' || !headers.includes(value)))
      .map(([field, value]) => `${field} -> ${value}`);
    if (invalid.length > 0) {
      return `Mapped columns are not in this file: ${invalid.join(', ')}`;
    }
  }

  return null;
};

const assertImportableResult = (result) => {
  if (result.totalRows === 0) {
    const err = new Error('No transaction rows found in this upload');
    err.statusCode = 400;
    throw err;
  }

  if (result.approvedRows === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  if (result.imported === 0 && result.duplicateRows >= result.approvedRows) {
    const err = new Error('No new transactions were imported; every valid row already exists');
    err.statusCode = 409;
    throw err;
  }

  // Nothing new, and what was not a duplicate contradicts a held sale (BE-03-T04): say which, not "the mapping".
  if (result.imported === 0 && result.conflictRows > 0 && result.duplicateRows + result.conflictRows >= result.approvedRows) {
    const err = new Error(`No new transactions were imported. ${result.firstConflictReason}`);
    err.statusCode = 409;
    throw err;
  }

  if (result.imported === 0 && result.errors > 0 && result.errors >= result.totalRows) {
    const err = new Error('No valid transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }
};

const assertParsedRowsImportable = (parsed, { allowSeverePartial = false } = {}) => {
  if (parsed.totalRows === 0) {
    const err = new Error('No transaction rows found in this upload');
    err.statusCode = 400;
    throw err;
  }

  if (parsed.rows.length === 0 && parsed.errors > 0 && parsed.errors >= parsed.totalRows) {
    const err = new Error('No valid transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const approvedRows = parsed.rows.filter((row) => normaliseTransactionStatus(row.status).status === 'approved');
  if (approvedRows.length === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const errorRatio = parsed.totalRows > 0 ? parsed.errors / parsed.totalRows : 0;
  if (
    !allowSeverePartial &&
    parsed.errors >= SEVERE_PARTIAL_MIN_ERRORS &&
    errorRatio >= SEVERE_PARTIAL_ERROR_RATIO
  ) {
    const err = new Error(
      `${parsed.errors} of ${parsed.totalRows} rows could not be parsed. Fix the mapping or explicitly allow a partial import.`
    );
    err.statusCode = 422;
    err.code = 'SEVERE_PARTIAL_IMPORT';
    err.details = {
      errors: parsed.errors,
      totalRows: parsed.totalRows,
      errorRatio: Number(errorRatio.toFixed(4)),
      rowErrors: sanitizeRowErrors(parsed.rowErrors),
    };
    throw err;
  }
};

module.exports = {
  MAX_LIST_PAGE, STORAGE_CLEANUP_PENDING, ABANDONED_CLEANUP_CLAIM, CONFIRMATION_KEY_MAX_LENGTH,
  confirmationMappingHash, sanitizeRowErrors, confirmationResponse, boundedInteger, validateUploadMapping,
  assertImportableResult, assertParsedRowsImportable, getCafeTimezone, describeOverlap,
};
