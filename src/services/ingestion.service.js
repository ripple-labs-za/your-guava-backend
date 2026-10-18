const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const Transaction = require('../models/Transaction.model');
const {
  parseBuffer,
  readCsv,
  readWorkbook,
  assertSupportedFileBuffer,
  MAX_ROW_ERRORS,
} = require('./parser.service');
const { zonedDateKey, safeTimezone } = require('../utils/timezone');
const {
  transactionIdentity, identityComparisonKey, resolveIdentities, tallyDuplicatesByUpload,
} = require('./transactionIdentity');
const {
  normaliseTransactionStatus,
  SKIP_REASON_STATUS,
  SKIP_REASON_DUPLICATE,
  SKIP_REASON_IN_FILE_DUPLICATE,
  SKIP_REASON_REFUND_NETTED,
} = require('../utils/transactionStatus');
const {
  rebuildItemsForCafe,
  reconcileTransactionItems,
  reconcileLines,
  menuItemResolverForRows,
} = require('./menuItems.service');

const YOCO_HEADERS = [
  'Receipt', 'Date', 'Time', 'Status', 'Payment Method', 'Order Number',
  'Card Reader', 'Items', 'Note', 'Currency', 'Tip', 'Discount', 'VAT',
  'Total (incl. tax)', 'Fee Amount', 'Net Amount',
];

/**
 * Returns true if the headers strongly match a Yoco export.
 * Looks for at least 6 of the canonical Yoco headers.
 */
const isYocoFormat = (headers) => {
  const matches = YOCO_HEADERS.filter((h) => headers.includes(h)).length;
  return matches >= 6;
};

const yocoMapping = () => ({
  mapping: {
    receiptId: 'Receipt',
    date: 'Date',
    time: 'Time',
    items: 'Items',
    total: 'Total (incl. tax)',
    tip: 'Tip',
    discount: 'Discount',
    paymentMethod: 'Payment Method',
    status: 'Status',
  },
  itemsMode: 'packed',
});

// The upload preview: the header row and the first five data rows, read exactly as the import reads them.
const PREVIEW_ROWS = 5;

const previewWorkbook = async (buffer) => {
  assertSupportedFileBuffer(buffer, 'xlsx');
  // Take the sheet's own header row rather than the keys of the first data row,
  // so an export covering a quiet period still reports its columns instead of
  // looking like a file whose headers could not be read.
  const { headers, rows } = await readWorkbook(buffer);
  return { headers, sampleRows: rows.slice(0, PREVIEW_ROWS) };
};

/**
 * Returns headers + first 5 rows for AI/preset analysis.
 */
const previewBuffer = async (buffer, fileExt = 'csv') => {
  assertSupportedFileBuffer(buffer, fileExt);
  if (fileExt === 'xlsx') return previewWorkbook(buffer);
  const { headers, rows } = await readCsv(buffer, { limit: PREVIEW_ROWS });
  return { headers, sampleRows: rows };
};

const cloneRowErrors = (rowErrors) =>
  Array.isArray(rowErrors) ? rowErrors.slice(0, MAX_ROW_ERRORS) : [];

/**
 * Every skipped row is counted under its reason and skipped is their sum, so it can never disagree with them. The
 * history used to say "412 skipped" and explain three: duplicates were counted but given no reason (BE-03-T09).
 */
const createSkipTally = () => {
  const byReason = {};
  const skip = (reason, count = 1) => {
    if (count > 0) byReason[reason] = (byReason[reason] || 0) + count;
  };
  const total = () => Object.values(byReason).reduce((sum, count) => sum + count, 0);
  return { skip, byReason, total };
};

const addPersistenceRowError = (rowErrors, row, reason) => {
  if (rowErrors.length >= MAX_ROW_ERRORS) return;
  const sourceRows = row?.__sourceRowNumbers;
  rowErrors.push({
    rowNumber: Array.isArray(sourceRows) ? sourceRows[0] : undefined,
    reason,
  });
};

/**
 * Identity used to recognise a transaction we already hold.
 *
 * A receipt number is only unique within a trading day on tills that restart
 * their numbering each morning, which is common. Scoping the identity by the
 * cafe-local day keeps re-uploads idempotent -- the same file yields the same
 * receipt on the same day -- while letting "#0001" on Tuesday and "#0001" on
 * Wednesday be recognised as the two different sales they are.
 */
const transactionDocument = (row, { cafeId, uploadId, identity }) => ({
  cafeId,
  uploadId,
  receiptId: identity.type === 'receiptId' ? identity.value : undefined,
  dedupKey: identity.type === 'dedupKey' ? identity.value : undefined,
  date: row.date,
  hour: row.hour,
  hourKnown: row.hourKnown !== false,
  dayOfWeek: row.dayOfWeek,
  status: 'approved',
  paymentMethod: row.paymentMethod,
  items: row.items,
  total: row.total,
  tip: row.tip,
  discount: row.discount,
  source: 'csv',
});

// The parser's own lines for each row, kept the first time a row is reconciled. A transaction retried after a menu-lock
// conflict (BE-03-T12) reconciles again, and reconciling the previous attempt's output took rawName from that attempt's
// menu name, so the till's own spelling was lost (review of BE-03-T12).
const parsedItemsOf = new WeakMap();

// Every distinct name in the file is resolved in one batch (BE-03-T13): caching per basket missed on almost every
// receipt, because the key held its unitPrice, so each ran its own find, upsert and $inc inside the transaction. The
// mismatch $inc is not repeated here: the import's rebuild recomputes priceMismatchCount from the stored lines.
const reconcileParsedRows = async (parsed, { cafeId, session }) => {
  const approved = parsed.rows.filter((row) => normaliseTransactionStatus(row.status).status === 'approved');
  for (const row of approved) if (!parsedItemsOf.has(row)) parsedItemsOf.set(row, row.items || []);
  const resolve = await menuItemResolverForRows(cafeId, approved.map((row) => ({ items: parsedItemsOf.get(row) })), session);
  for (const row of approved) row.items = reconcileLines(parsedItemsOf.get(row), resolve);
  return parsed;
};

const persistParsedRowsBulk = async (
  parsed,
  {
    cafeId,
    uploadId,
    session,
    itemsAlreadyReconciled = false,
    failOnPersistenceError = false,
    timezone,
  }
) => {
  const skips = createSkipTally();
  let errors = parsed.errors;
  const rowErrors = cloneRowErrors(parsed.rowErrors);
  let approvedRows = 0;
  let declinedRows = 0;
  let duplicateRows = 0;
  const approved = [];
  // Refund rows netted into the partially refunded sale they refund (BE-03-T07, D-021): counted, never imported alone.
  skips.skip(SKIP_REASON_REFUND_NETTED, parsed.nettedRefundRows || 0);

  for (const row of parsed.rows) {
    const { status, recognised } = normaliseTransactionStatus(row.status);
    if (status !== 'approved') {
      skips.skip(SKIP_REASON_STATUS);
      declinedRows++;
      if (!recognised) {
        addPersistenceRowError(
          rowErrors,
          row,
          `Status "${row.statusRaw || row.status}" is not a recognised sale status`
        );
      }
      continue;
    }
    approvedRows++;
    try {
      if (!itemsAlreadyReconciled) {
        row.items = await reconcileTransactionItems(cafeId, row.items, { session });
      }
      approved.push(row);
    } catch (error) {
      // These two lines used to be dead: an unconditional rethrow on the next
      // statement discarded both, so one unreconcilable line aborted the whole
      // import and the owner was told "import failed" with no row number. The
      // upload flow still asks to fail hard -- it commits in a single
      // transaction and cannot land a partial batch -- but every other caller
      // now gets the row error the machinery was built to carry.
      errors++;
      addPersistenceRowError(rowErrors, row, 'Could not reconcile row items');
      if (failOnPersistenceError) throw error;
    }
  }

  // One identity rule (BE-03-T03): receipts by number, cafe-local day and content (BE-03-T04), receipt-less sales by
  // content, counted. A reused number whose contents contradict a held sale at the same minute is a named row error.
  const resolution = await resolveIdentities(approved, { cafeId, session, timezone });
  for (const { row, reason } of resolution.conflicts) {
    errors += 1;
    addPersistenceRowError(rowErrors, row, reason);
  }
  const existingDuplicateRows = resolution.duplicates.length;
  const inFileDuplicateRows = resolution.inFileDuplicates;
  skips.skip(SKIP_REASON_DUPLICATE, existingDuplicateRows);
  skips.skip(SKIP_REASON_IN_FILE_DUPLICATE, inFileDuplicateRows);
  duplicateRows += existingDuplicateRows + inFileDuplicateRows;

  const documents = resolution.importable.map(({ row, identity }) =>
    transactionDocument(row, { cafeId, uploadId, identity })
  );
  if (documents.length > 0) {
    await Transaction.insertMany(documents, { ordered: true, ...(session ? { session } : {}) });
  }

  return {
    imported: documents.length,
    skipped: skips.total(),
    skippedByReason: skips.byReason,
    errors,
    rowErrors,
    totalRows: parsed.totalRows,
    approvedRows,
    declinedRows,
    duplicateRows,
    existingDuplicateRows,
    inFileDuplicateRows,
    conflictRows: resolution.conflicts.length,
    firstConflictReason: resolution.conflicts[0]?.reason || null,
    duplicatesByUpload: tallyDuplicatesByUpload(resolution.duplicates),
    dateRange: parsed.dateRange,
  };
};

/**
 * Persistence-only half of ingestion: takes an already-parsed result object and
 * writes transactions + item upserts to the database. Does NOT touch R2 or the
 * file system. Safe to call after a successful parseBuffer call.
 *
 * @param {object} parsed  — the object returned by parseBuffer
 * @param {object} opts
 * @param {string} opts.cafeId
 * @param {string} opts.uploadId
 * @returns {Promise<{imported: number, skipped: number, errors: number, rowErrors: object[], totalRows: number, dateRange: object}>}
 */
const persistParsedRows = async (
  parsed,
  {
    cafeId,
    uploadId,
    session,
    bulk = false,
    itemsAlreadyReconciled = false,
    rebuildItems = true,
    failOnPersistenceError = false,
    sourceFingerprint,
    timezone,
  }
) => {
  if (bulk) {
    const result = await persistParsedRowsBulk(parsed, {
      cafeId,
      uploadId,
      session,
      itemsAlreadyReconciled,
      failOnPersistenceError,
      sourceFingerprint,
      timezone,
    });
    if (rebuildItems) await rebuildItemsForCafe(cafeId, { session });
    return result;
  }

  let imported = 0;
  const skips = createSkipTally();
  let errors = parsed.errors;
  const rowErrors = cloneRowErrors(parsed.rowErrors);
  let approvedRows = 0;
  let declinedRows = 0;
  let duplicateRows = 0;
  const zone = safeTimezone(timezone);
  // Identities already written by this call: a second sighting is a repeat inside the file, not an earlier upload.
  const writtenHere = new Set();
  skips.skip(SKIP_REASON_REFUND_NETTED, parsed.nettedRefundRows || 0);

  for (const row of parsed.rows) {
    try {
      const { status, recognised } = normaliseTransactionStatus(row.status);
      if (status !== 'approved') {
        skips.skip(SKIP_REASON_STATUS);
        declinedRows++;
        if (!recognised) {
          addPersistenceRowError(
            rowErrors,
            row,
            `Status "${row.statusRaw || row.status}" is not a recognised sale status`
          );
        }
        continue;
      }
      approvedRows++;

      // Identity is the same rule on both paths. This loop used to filter on
      // the receipt ID alone, with no trading day, which is the very defect the
      // day scoping was added to fix: on a till that restarts its order numbers
      // each morning, Wednesday's "#0001" was recognised as Tuesday's and
      // dropped, so a month of history collapsed to one day's receipts.
      const identity = transactionIdentity(row, sourceFingerprint, timezone);
      const dedupKey = identity.type === 'dedupKey' ? identity.value : undefined;

      let existingQuery = identity.type === 'receiptId'
        ? Transaction.find({ cafeId, receiptId: identity.value }).select('date')
        : Transaction.find({ cafeId, dedupKey: identity.value }).select('date');
      if (session) existingQuery = existingQuery.session(session);
      const matches = await existingQuery.lean();
      // Stored rows keep only the instant, so the trading day is recomputed in
      // the cafe's timezone rather than read off a UTC date.
      const existing = identity.type === 'receiptId'
        ? matches.some((match) => zonedDateKey(match.date, zone) === identity.dayKey)
        : matches.length > 0;
      if (existing) {
        skips.skip(writtenHere.has(identityComparisonKey(identity)) ? SKIP_REASON_IN_FILE_DUPLICATE : SKIP_REASON_DUPLICATE);
        duplicateRows++;
        continue;
      }

      const reconciledItems = itemsAlreadyReconciled
        ? row.items
        : await reconcileTransactionItems(cafeId, row.items, { session });

      const document = {
        cafeId,
        uploadId,
        receiptId: row.receiptId,
        dedupKey,
        date: row.date,
        hour: row.hour,
        hourKnown: row.hourKnown !== false,
        dayOfWeek: row.dayOfWeek,
        status: 'approved',
        paymentMethod: row.paymentMethod,
        items: reconciledItems,
        total: row.total,
        tip: row.tip,
        discount: row.discount,
        source: 'csv',
      };
      if (session) await Transaction.create([document], { session });
      else await Transaction.create(document);
      writtenHere.add(identityComparisonKey(identity));
      imported++;
    } catch (err) {
      if (err.code === 11000) {
        skips.skip(SKIP_REASON_DUPLICATE);
        duplicateRows++;
      } else {
        if (failOnPersistenceError) throw err;
        logger.error('ingestion_row_failed', logger.errorFields(err));
        errors++;
        addPersistenceRowError(rowErrors, row, 'Could not save row');
      }
    }
  }

  if (rebuildItems) await rebuildItemsForCafe(cafeId, { session });

  return {
    imported,
    skipped: skips.total(),
    skippedByReason: skips.byReason,
    errors,
    rowErrors,
    totalRows: parsed.totalRows,
    approvedRows,
    declinedRows,
    duplicateRows,
    dateRange: parsed.dateRange,
  };
};

/**
 * Phase 2: parses a buffer using the given mapping and writes transactions.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string} opts.cafeId
 * @param {string} opts.uploadId
 * @param {object} opts.columnMapping
 * @param {'packed'|'line-per-row'} opts.itemsMode
 * @param {string} [opts.fileExt='csv']
 * @returns {Promise<{imported: number, skipped: number, errors: number, totalRows: number, dateRange: object}>}
 */
const ingestParsedRows = async (
  buffer,
  {
    cafeId,
    uploadId,
    columnMapping,
    itemsMode,
    fileExt = 'csv',
    timezone,
    sourceFingerprint,
  }
) => {
  const parsed = await parseBuffer(buffer, { columnMapping, itemsMode, fileExt, timezone });
  return persistParsedRows(parsed, { cafeId, uploadId, sourceFingerprint, timezone });
};

/**
 * Legacy file-path API. Reads a local file and ingests using the Yoco preset.
 * Preserved so the existing transactions.controller.upload tests still pass while
 * the new two-phase flow is being built up.
 */
const ingestFile = async (filePath, cafeId) => {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const { mapping, itemsMode } = yocoMapping();
  return ingestParsedRows(buffer, { cafeId, uploadId: null, columnMapping: mapping, itemsMode, fileExt: ext });
};

// Backward-compat alias — unit tests written before the refactor still call this
const parseYocoCSV = ingestFile;

module.exports = {
  ingestFile,
  ingestParsedRows,
  persistParsedRows,
  reconcileParsedRows,
  isYocoFormat,
  yocoMapping,
  previewBuffer,
  rebuildItemsForCafe,
  parseYocoCSV,
};
