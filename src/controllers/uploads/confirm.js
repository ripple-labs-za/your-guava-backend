// POST /uploads/:id/confirm: parse under the lease and commit the rows.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const r2 = require('../../services/r2.service');
const parser = require('../../services/parser.service');
const { clearApiCache } = require('../../middleware/cache.middleware');
const {
  CONFIRMATION_KEY_MAX_LENGTH, confirmationMappingHash, confirmationResponse, validateUploadMapping, getCafeTimezone, assertParsedRowsImportable,
} = require('./shared');
const { sha256Hex } = require('../../utils/authPrimitives');
const {
  recoverStaleParsingUpload, snapshotUploadState, lockUploadForParsing, touchParsingLease, commitParsedUpload, restoreUploadAfterFailure,
} = require('./lease');
const { schedulePostImportMaintenance } = require('./jobs');
const { activeCafeId } = require('../../utils/tenancy');

const confirm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      columnMapping,
      itemsMode = 'packed',
      allowPartialImport = false,
    } = req.body;
    const cafeId = activeCafeId(req);
    const idempotencyKey = String(req.get?.('Idempotency-Key') || '').trim();
    if (idempotencyKey.length > CONFIRMATION_KEY_MAX_LENGTH) {
      return res.status(400).json({ success: false, message: 'Idempotency-Key is too long' });
    }
    const mappingHash = confirmationMappingHash(columnMapping, itemsMode);
    const idempotencyKeyHash = idempotencyKey ? sha256Hex(idempotencyKey) : undefined;

    let upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    upload = await recoverStaleParsingUpload(upload, cafeId);
    if (upload.status === 'completed') {
      if (upload.confirmation?.mappingHash && upload.confirmation.mappingHash !== mappingHash) {
        // The key was stored on the first confirm and never read, so a client that
        // reused one key for two different mappings got the same advice as an owner
        // deliberately changing their columns. They are different problems: one is a
        // bug to fix, the other is a feature to use, and only the caller can tell
        // them apart if we say which happened.
        if (idempotencyKeyHash && upload.confirmation?.idempotencyKeyHash === idempotencyKeyHash) {
          return res.status(409).json({
            success: false,
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used for a different mapping. '
              + 'Use a new key, or remap the upload to change its columns.',
          });
        }
        return res.status(409).json({
          success: false,
          code: 'MAPPING_ALREADY_COMMITTED',
          message: 'Upload already completed with a different mapping. Use remap to change it.',
        });
      }
      upload = await Upload.findOneAndUpdate(
        { _id: upload._id, cafeId, status: 'completed' },
        { $inc: { 'confirmation.replayCount': 1 } },
        { new: true }
      );
      // A remap or delete took the upload between the read and this replay; answering from null was a 500 (BE-03-T12).
      if (!upload) {
        return res.status(409).json({
          success: false, code: 'UPLOAD_CHANGED',
          message: 'This upload changed while it was being confirmed. Refresh the page and try again.',
        });
      }
      return res.status(200).json(confirmationResponse(upload, { replayed: true }));
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

    try {
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
      upload = await touchParsingLease(upload._id, cafeId, expectedUpdatedAt);
      expectedUpdatedAt = upload.updatedAt;

      const committed = await commitParsedUpload({
        upload,
        cafeId,
        parsed,
        columnMapping,
        itemsMode,
        persistMapping: upload.posType === 'wizard',
        mappingHash,
        idempotencyKeyHash,
        timezone,
      });
      upload = committed.upload;
      result = committed.result;
    } catch (err) {
      const rowErrors = result?.rowErrors || parsed?.rowErrors || previousUploadState.rowErrors;
      await restoreUploadAfterFailure({
        uploadId: upload._id,
        cafeId,
        expectedUpdatedAt,
        previousState: previousUploadState,
        error: err,
        rowErrors,
        markFailed: true,
      });
      throw err;
    }

    clearApiCache({ cafeId });
    await schedulePostImportMaintenance(upload._id, cafeId, result.dateRange, timezone);
    return res.status(200).json(confirmationResponse(upload));
  } catch (error) {
    next(error);
  }
};

module.exports = {
  confirm,
};
