const logger = require('../../utils/logger');
// The abandoned-upload sweeper server.js runs on a timer.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const Transaction = require('../../models/Transaction.model');
const r2 = require('../../services/r2.service');
const { boundedInteger, ABANDONED_CLEANUP_CLAIM, STORAGE_CLEANUP_PENDING } = require('./shared');
const { parsingLeaseMs, recoverStaleParsing } = require('./lease');

const DEFAULT_PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
// D-022: a failed upload imported nothing; its file is the owner's raw POS export, kept a week for a retry (BE-03-T12).
const DEFAULT_FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLEANUP_BATCH = 100;

const pendingRetentionMs = () => boundedInteger(
  process.env.UPLOAD_PENDING_RETENTION_MS,
  DEFAULT_PENDING_RETENTION_MS,
  60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000
);

const failedRetentionMs = () => boundedInteger(
  process.env.UPLOAD_FAILED_RETENTION_MS,
  DEFAULT_FAILED_RETENTION_MS,
  60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000
);

/**
 * An upload a crash or deploy left 'parsing' with no cleanup claim said "parsing" for ever unless the owner touched it
 * (uploads-catalogue-12). Past the parse lease it goes back to completed if it ever completed, else failed; a live
 * import keeps its lease fresh, so it is never touched.
 */
const recoverCrashedParsing = async (staleBefore, limit) => {
  const stale = await Upload.find({
    status: 'parsing', errorMessage: { $ne: ABANDONED_CLEANUP_CLAIM }, updatedAt: { $lte: staleBefore },
  }).select('_id cafeId completedAt').sort({ updatedAt: 1 }).limit(limit).lean();
  let recovered = 0;
  for (const candidate of stale) if (await recoverStaleParsing(candidate, staleBefore)) recovered += 1;
  return recovered;
};

// A failed upload whose file could not be deleted goes back exactly as it was: its own reason, or none if it had none,
// replaces the cleanup claim, and its age is kept so the next run retries it.
const restoreFailedUpload = ({ errorMessage, updatedAt }) => (errorMessage === undefined
  ? { $set: { status: 'failed', updatedAt }, $unset: { errorMessage: '' } }
  : { $set: { status: 'failed', errorMessage, updatedAt } });

const cleanupAbandonedPendingUploads = async ({
  olderThanMs = pendingRetentionMs(),
  limit = MAX_CLEANUP_BATCH,
} = {}) => {
  const cutoff = new Date(Date.now() - boundedInteger(
    olderThanMs,
    pendingRetentionMs(),
    60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000
  ));
  const staleCleanupBefore = new Date(Date.now() - parsingLeaseMs());
  const batchLimit = boundedInteger(limit, MAX_CLEANUP_BATCH, 1, MAX_CLEANUP_BATCH);
  const pendingLimit = batchLimit === 1 ? 1 : Math.max(1, Math.floor(batchLimit * 0.75));
  const recoveredParsing = await recoverCrashedParsing(staleCleanupBefore, batchLimit);
  const candidates = await Upload.find({
    $or: [
      { status: 'pending_mapping', updatedAt: { $lte: cutoff } },
      {
        status: 'parsing',
        errorMessage: ABANDONED_CLEANUP_CLAIM,
        updatedAt: { $lte: staleCleanupBefore },
      },
      // A failed upload goes through the same claim, file delete and tombstone after its retention window (D-022).
      { status: 'failed', updatedAt: { $lte: new Date(Date.now() - failedRetentionMs()) } },
    ],
  }).select('_id cafeId r2Key status errorMessage updatedAt').sort({ updatedAt: 1 }).limit(pendingLimit).lean();

  const summary = {
    scanned: candidates.length,
    deleted: 0,
    failed: 0,
    storageScanned: 0,
    storageRetried: 0,
    recoveredParsing,
    expiredFailed: 0,
  };
  for (const candidate of candidates) {
    // A failed upload whose rows are held (a remap that failed after an earlier import) is not an abandoned file. Its
    // age is reset so it leaves the front of the queue: left as it was it took a batch slot on every run (review).
    if (candidate.status === 'failed' && await Transaction.exists({ cafeId: candidate.cafeId, uploadId: candidate._id })) {
      await Upload.updateOne({ _id: candidate._id, status: 'failed', updatedAt: candidate.updatedAt }, { $currentDate: { updatedAt: true } });
      continue;
    }
    const claimed = await Upload.findOneAndUpdate(
      {
        _id: candidate._id,
        status: candidate.status,
        updatedAt: candidate.updatedAt,
        ...(candidate.status === 'parsing'
          ? { errorMessage: ABANDONED_CLEANUP_CLAIM }
          : {}),
      },
      {
        $set: {
          status: 'parsing',
          errorMessage: ABANDONED_CLEANUP_CLAIM,
        },
      },
      { new: true }
    );
    if (!claimed) continue;

    try {
      await r2.deleteFile(claimed.r2Key);
    } catch (error) {
      summary.failed++;
      // A failed upload goes back exactly as it was (status, its own error, its age), so the owner still reads why it
      // failed and the next run retries at once; an unconfirmed one keeps today's behaviour.
      const restore = candidate.status === 'failed'
        ? [restoreFailedUpload(candidate), { timestamps: false }]
        : [{ $set: { status: 'pending_mapping', errorMessage: 'Could not remove expired upload storage; cleanup will retry.' } }];
      await Upload.updateOne({ _id: claimed._id, status: 'parsing', updatedAt: claimed.updatedAt }, ...restore);
      continue;
    }

    try {
      const marked = await Upload.updateOne(
        { _id: claimed._id, status: 'parsing', updatedAt: claimed.updatedAt },
        {
          $set: {
            status: 'deleted',
            errorMessage: candidate.status === 'failed'
              ? 'Failed upload expired and its stored file was removed.'
              : 'Unconfirmed upload expired and its stored file was removed.',
            r2Key: `deleted/${claimed._id}`,
            fileName: 'deleted-upload',
            fileSize: 0,
            headers: [],
            sampleRows: [],
            rowErrors: [],
            columnMapping: {},
          },
          $unset: {
            fileFingerprint: '',
            confirmation: '',
            dateRange: '',
            completedAt: '',
          },
        }
      );
      if (marked.modifiedCount === 1) {
        summary.deleted++;
        if (candidate.status === 'failed') summary.expiredFailed++;
      } else summary.failed++;
    } catch (error) {
      summary.failed++;
      logger.error('upload_expiry_finalize_failed', logger.errorFields(error));
    }
  }

  const retryLimit = Math.max(0, batchLimit - candidates.length);
  if (retryLimit > 0) {
    const storageRetries = await Upload.find({
      status: 'deleted',
      errorMessage: STORAGE_CLEANUP_PENDING,
    }).select('_id r2Key').sort({ updatedAt: 1 }).limit(retryLimit).lean();
    summary.storageScanned = storageRetries.length;
    for (const upload of storageRetries) {
      try {
        await r2.deleteFile(upload.r2Key);
        const cleared = await Upload.updateOne(
          { _id: upload._id, status: 'deleted', errorMessage: STORAGE_CLEANUP_PENDING },
          { $unset: { errorMessage: '' } }
        );
        if (cleared.modifiedCount === 1) summary.storageRetried++;
      } catch (error) {
        summary.failed++;
      }
    }
  }
  return summary;
};

module.exports = {
  pendingRetentionMs, failedRetentionMs, cleanupAbandonedPendingUploads,
};
