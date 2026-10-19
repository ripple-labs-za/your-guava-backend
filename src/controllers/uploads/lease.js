// The parsing-lease state machine: lock, touch, snapshot, restore and commit an upload being parsed.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const readmissionService = require('../../services/readmission.service');
const Upload = require('../../models/Upload.model');
const Transaction = require('../../models/Transaction.model');
const Cafe = require('../../models/Cafe.model');
const { invalidatePlanningForecasts: invalidateForecastInputs } = require('../../services/forecast.service');
const GeneratedInsight = require('../../models/GeneratedInsight.model');
const ingestion = require('../../services/ingestion.service');
const parser = require('../../services/parser.service');
const { zonedDateKey } = require('../../utils/timezone');
const {
  boundedInteger, ABANDONED_CLEANUP_CLAIM, sanitizeRowErrors, assertImportableResult, confirmationMappingHash, describeOverlap,
} = require('./shared');
const { lockCafeMenu } = require('../../services/menuItems.service');

const DEFAULT_PARSING_LEASE_MS = 15 * 60 * 1000;
const MAX_PARSING_LEASE_MS = 60 * 60 * 1000;

const parsingLeaseMs = () => boundedInteger(
  process.env.UPLOAD_PARSING_LEASE_MS,
  DEFAULT_PARSING_LEASE_MS,
  60 * 1000,
  MAX_PARSING_LEASE_MS
);

/**
 * Puts an upload whose parse lease ran out back to where it was: completed if it ever completed (an interrupted remap),
 * else failed. Returns the recovered document, or null when it changed meanwhile. Used when the owner touches the
 * upload, and by the sweeper for one nobody touches after a crash or deploy (BE-03-T12).
 */
const recoverStaleParsing = (upload, staleBefore) => Upload.findOneAndUpdate(
  { _id: upload._id, cafeId: upload.cafeId, status: 'parsing', updatedAt: { $lte: staleBefore } },
  {
    $set: {
      status: upload.completedAt ? 'completed' : 'failed',
      errorMessage: 'Previous import did not finish; the upload is available to retry.',
    },
  },
  { new: true }
);

const recoverStaleParsingUpload = async (upload, cafeId) => {
  if (upload.status !== 'parsing') return upload;
  if (upload.errorMessage === ABANDONED_CLEANUP_CLAIM) {
    const err = new Error('This unconfirmed upload expired and is being removed.');
    err.statusCode = 410;
    throw err;
  }
  const staleBefore = new Date(Date.now() - parsingLeaseMs());
  if (upload.updatedAt > staleBefore) {
    const err = new Error('Upload is already being parsed. Please retry after it finishes.');
    err.statusCode = 409;
    throw err;
  }

  const recovered = await recoverStaleParsing({ _id: upload._id, cafeId, completedAt: upload.completedAt }, staleBefore);

  if (!recovered) {
    const err = new Error('Upload status changed while recovering a stale import. Please refresh and retry.');
    err.statusCode = 409;
    throw err;
  }
  return recovered;
};

const lockUploadForParsing = async (upload, cafeId) => {
  const locked = await Upload.findOneAndUpdate(
    {
      _id: upload._id,
      cafeId,
      status: upload.status,
      updatedAt: upload.updatedAt,
    },
    {
      $set: { status: 'parsing' },
      $unset: { errorMessage: '' },
    },
    { new: true }
  );

  if (!locked) {
    const err = new Error('Upload status changed while import was starting. Please refresh and try again.');
    err.statusCode = 409;
    throw err;
  }

  return locked;
};

const touchParsingLease = async (uploadId, cafeId, expectedUpdatedAt) => {
  const touched = await Upload.findOneAndUpdate(
    { _id: uploadId, cafeId, status: 'parsing', updatedAt: expectedUpdatedAt },
    { $currentDate: { updatedAt: true } },
    { new: true }
  );
  if (!touched) {
    const err = new Error('Upload parsing lease was lost. Please refresh before retrying.');
    err.statusCode = 409;
    throw err;
  }
  return touched;
};

const snapshotUploadState = (upload) => ({
  status: upload.status,
  columnMapping: upload.columnMapping?.toObject
    ? upload.columnMapping.toObject()
    : { ...(upload.columnMapping || {}) },
  itemsMode: upload.itemsMode,
  stats: upload.stats?.toObject ? upload.stats.toObject() : { ...(upload.stats || {}) },
  dateRange: upload.dateRange?.toObject
    ? upload.dateRange.toObject()
    : { ...(upload.dateRange || {}) },
  rowErrors: Array.isArray(upload.rowErrors)
    ? upload.rowErrors.map((rowError) => (
      rowError?.toObject ? rowError.toObject() : { ...rowError }
    ))
    : [],
  completedAt: upload.completedAt,
});

const restoreUploadAfterFailure = async ({
  uploadId,
  cafeId,
  expectedUpdatedAt,
  previousState,
  error,
  rowErrors,
  markFailed,
}) => {
  const status = markFailed && ['pending_mapping', 'failed'].includes(previousState.status)
    ? 'failed'
    : previousState.status;
  const set = {
    status,
    columnMapping: previousState.columnMapping,
    itemsMode: previousState.itemsMode,
    stats: previousState.stats,
    dateRange: previousState.dateRange,
    rowErrors: sanitizeRowErrors(rowErrors || previousState.rowErrors),
    errorMessage: error.message,
  };
  const update = { $set: set };
  if (previousState.completedAt) set.completedAt = previousState.completedAt;
  else update.$unset = { completedAt: '' };

  await Upload.updateOne(
    { _id: uploadId, cafeId, status: 'parsing', updatedAt: expectedUpdatedAt },
    update
  );
};

const commitParsedUpload = async ({
  upload,
  cafeId,
  parsed,
  columnMapping,
  itemsMode,
  persistMapping,
  mappingHash,
  idempotencyKeyHash,
  timezone,
  readmission: prepared = [],
}) => {
  let result;
  let readmitted = { applied: [], stale: [] };
  let committedUpload;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // First, so a menu edit or another import of this cafe waits for this one rather than interleaving (BE-03-T12).
      // Taken only at the rebuild, every menu write that committed meanwhile (a Yoco webhook's rebuild, an edit) made the
      // whole import retry; first, the short writes wait for the long one. Measured 3x per placement: no cost to the
      // 10,000-row import budget (evidence ab-lock-3x3.txt).
      await lockCafeMenu(cafeId, session);
      await ingestion.reconcileParsedRows(parsed, { cafeId, session });
      await Transaction.deleteMany({ cafeId, uploadId: upload._id }).session(session);
      result = await ingestion.persistParsedRows(parsed, {
        cafeId,
        uploadId: upload._id,
        session,
        itemsAlreadyReconciled: true,
        rebuildItems: false,
        failOnPersistenceError: true,
        timezone,
      });
      assertImportableResult(result);
      const overlap = await describeOverlap(result.duplicatesByUpload, { cafeId, session });
      // A remap that no longer imports some rows lets overlapping uploads re-admit them (BE-03-T02).
      readmitted = await readmissionService.applyReadmission({ prepared, cafeId, session, timezone });
      await ingestion.rebuildItemsForCafe(cafeId, { session, pruneOrphans: true });

      committedUpload = await Upload.findOneAndUpdate(
        {
          _id: upload._id,
          cafeId,
          status: 'parsing',
          updatedAt: upload.updatedAt,
        },
        {
          $set: {
            status: 'completed',
            columnMapping,
            itemsMode,
            // If the confirmed mapping is not the one we staged, a human chose it in
            // the wizard. Saying 'AI mapping' on a mapping the owner corrected by
            // hand would credit the guess for their work.
            mappingSource:
              confirmationMappingHash(columnMapping, itemsMode)
              === confirmationMappingHash(upload.columnMapping || {}, upload.itemsMode)
                ? upload.mappingSource || 'manual'
                : 'manual',
            stats: {
              imported: result.imported,
              skipped: result.skipped,
              skippedByReason: result.skippedByReason || {},
              errors: result.errors,
              totalRows: result.totalRows,
            },
            overlap,
            dateRange: {
              ...result.dateRange,
              firstDateKey: result.dateRange?.firstDate
                ? zonedDateKey(result.dateRange.firstDate, timezone)
                : undefined,
              lastDateKey: result.dateRange?.lastDate
                ? zonedDateKey(result.dateRange.lastDate, timezone)
                : undefined,
            },
            rowErrors: sanitizeRowErrors(result.rowErrors || parsed.rowErrors),
            completedAt: new Date(),
            confirmation: {
              mappingHash,
              idempotencyKeyHash,
              replayCount: 0,
            },
            maintenance: {
              status: 'queued',
              errors: [],
            },
          },
          $unset: { errorMessage: '' },
        },
        { new: true, session }
      );
      if (!committedUpload) {
        const err = new Error('Upload parsing lease was lost before the import could commit');
        err.statusCode = 409;
        throw err;
      }

      const cafeFields = { dataUploaded: true, lastSyncAt: new Date() };
      if (persistMapping) {
        cafeFields.savedColumnMapping = {
          ...parser.pickColumnMapping(columnMapping),
          itemsMode,
          sourceHeaders: Array.isArray(upload.headers) ? [...upload.headers] : [],
          savedAt: new Date(),
          sourceUploadId: upload._id,
          sourceFileName: upload.fileName,
        };
      }
      const cafeUpdate = await Cafe.findByIdAndUpdate(
        cafeId,
        { $set: cafeFields },
        { session }
      );
      if (!cafeUpdate) {
        const err = new Error('Cafe not found while completing upload');
        err.statusCode = 404;
        throw err;
      }

      // Readers must never observe forecasts or generated insights based on
      // the pre-import dataset, even if the asynchronous regeneration worker
      // starts later or this process exits immediately after commit.
      await invalidateForecastInputs(cafeId, { timezone, session });
      await GeneratedInsight.updateOne(
        { cafeId },
        { $set: { invalidatedAt: new Date() } },
        { session }
      );
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
  return { upload: committedUpload, result, readmitted };
};

module.exports = {
  DEFAULT_PARSING_LEASE_MS, MAX_PARSING_LEASE_MS, parsingLeaseMs, recoverStaleParsing, recoverStaleParsingUpload, lockUploadForParsing,
  touchParsingLease,
  snapshotUploadState, restoreUploadAfterFailure, commitParsedUpload,
};
