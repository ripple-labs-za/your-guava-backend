// PATCH /uploads/:id/mapping: re-import an upload under a new mapping.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const r2 = require('../../services/r2.service');
const parser = require('../../services/parser.service');
const { normaliseTransactionStatus } = require('../../utils/transactionStatus');
const { clearApiCache } = require('../../middleware/cache.middleware');
const {
  transactionIdentity, identityComparisonKey, findExistingIdentities,
} = require('../../services/transactionIdentity');
const {
  CONFIRMATION_KEY_MAX_LENGTH, validateUploadMapping, getCafeTimezone, assertParsedRowsImportable, confirmationMappingHash, confirmationResponse,
} = require('./shared');
const { sha256Hex } = require('../../utils/authPrimitives');
const {
  recoverStaleParsingUpload, snapshotUploadState, lockUploadForParsing, touchParsingLease, commitParsedUpload, restoreUploadAfterFailure,
} = require('./lease');
const { schedulePostImportMaintenance, recoverPendingUploadMaintenance } = require('./jobs');
const readmission = require('../../services/readmission.service');
const { zonedDateKey } = require('../../utils/timezone');
const { activeCafeId } = require('../../utils/tenancy');

const assertRemapHasImportableRows = async (parsed, cafeId, uploadId, sourceFingerprint, timezone) => {
  const approvedRows = parsed.rows.filter((row) => normaliseTransactionStatus(row.status).status === 'approved');
  if (approvedRows.length === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const identities = approvedRows.map((row) => transactionIdentity(row, sourceFingerprint, timezone));
  const existing = await findExistingIdentities(cafeId, identities, { timezone, excludeUploadId: uploadId });
  const duplicateRows = identities.filter((identity) => existing.has(identityComparisonKey(identity))).length;

  if (duplicateRows === approvedRows.length) {
    const err = new Error('Every valid row already exists in another upload; remap would leave this upload empty');
    err.statusCode = 409;
    throw err;
  }
};

const remap = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnMapping, itemsMode = 'packed', allowPartialImport = false } = req.body;
    const cafeId = activeCafeId(req);
    // Remap deliberately discarded its key, so a retried re-import looked like a
    // fresh one. Record it like confirm does.
    const remapKey = String(req.get?.('Idempotency-Key') || '').trim();
    if (remapKey.length > CONFIRMATION_KEY_MAX_LENGTH) {
      return res.status(400).json({ success: false, message: 'Idempotency-Key is too long' });
    }
    const remapKeyHash = remapKey ? sha256Hex(remapKey) : undefined;

    let upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    upload = await recoverStaleParsingUpload(upload, cafeId);
    if (upload.status === 'pending_mapping') {
      return res.status(409).json({ success: false, message: `Cannot remap while ${upload.status}` });
    }

    const mappingError = validateUploadMapping(upload, columnMapping, itemsMode);
    if (mappingError) {
      return res.status(400).json({ success: false, message: mappingError });
    }

    const previousUploadState = snapshotUploadState(upload);
    const timezone = await getCafeTimezone(cafeId);
    upload = await lockUploadForParsing(upload, cafeId);
    let expectedUpdatedAt = upload.updatedAt;
    let parsed;
    let result;
    let plan = { prepared: [], deferred: [], range: null };
    let readmitted = { applied: [], stale: [] };

    try {
      // 1. Parse first (read-only — can fail without any side effects)
      const buffer = await r2.downloadFile(upload.r2Key);
      if (!Buffer.isBuffer(buffer)) {
        const err = new Error('Original upload file is unavailable');
        err.statusCode = 503;
        throw err;
      }
      const ext = upload.fileName.split('.').pop().toLowerCase();
      parsed = await parser.parseBuffer(buffer, {
        columnMapping,
        itemsMode,
        fileExt: ext,
        timezone,
      });
      assertParsedRowsImportable(parsed, { allowSeverePartial: allowPartialImport === true });
      await assertRemapHasImportableRows(
        parsed,
        cafeId,
        upload._id,
        upload.fileFingerprint || sha256Hex(upload.r2Key),
        timezone
      );
      // Whatever the new mapping no longer imports, overlapping uploads may re-admit (BE-03-T02).
      const range = readmission.unionDayRange(
        readmission.uploadDayRange(upload, timezone),
        parsed.dateRange?.firstDate
          ? {
            firstDateKey: zonedDateKey(parsed.dateRange.firstDate, timezone),
            lastDateKey: zonedDateKey(parsed.dateRange.lastDate, timezone),
          }
          : null
      );
      plan = await readmission.prepareReadmission({ cafeId, range, excludeUploadId: upload._id, timezone });

      // 2. Parse succeeded — now safe to delete existing transactions
      upload = await touchParsingLease(upload._id, cafeId, expectedUpdatedAt);
      expectedUpdatedAt = upload.updatedAt;

      const committed = await commitParsedUpload({
        upload,
        cafeId,
        parsed,
        columnMapping,
        itemsMode,
        persistMapping: false,
        mappingHash: confirmationMappingHash(columnMapping, itemsMode),
        idempotencyKeyHash: remapKeyHash,
        timezone,
        readmission: plan.prepared,
      });
      upload = committed.upload;
      result = committed.result;
      readmitted = committed.readmitted;

      // Invalidate planning forecasts so they regenerate with fresh data.
      // Keep historical forecasts so imported actuals can be matched to the original predictions.
    } catch (err) {
      await restoreUploadAfterFailure({
        uploadId: upload._id,
        cafeId,
        expectedUpdatedAt,
        previousState: previousUploadState,
        error: err,
        rowErrors: previousUploadState.rowErrors,
        markFailed: false,
      });
      throw err;
    }

    const queued = [...plan.deferred, ...readmitted.stale];
    if (queued.length > 0) {
      await readmission.queueReadmission(queued, plan.range, upload._id);
      setImmediate(() => {
        recoverPendingUploadMaintenance({ limit: queued.length }).catch((error) => {
          console.error('[uploads] re-admission kick failed:', error.message);
        });
      });
    }

    clearApiCache();
    await schedulePostImportMaintenance(upload._id, cafeId, result.dateRange, timezone);
    return res.status(200).json({
      ...confirmationResponse(upload),
      readmitted: readmission.summariseReadmission(readmitted.applied),
      readmissionQueued: queued.map(({ _id, fileName }) => ({ uploadId: _id, fileName })),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  assertRemapHasImportableRows, remap,
};
