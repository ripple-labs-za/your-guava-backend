const { runInBackground } = require('../../utils/lifecycle');
const logger = require('../../utils/logger');
// DELETE /uploads/:id: remove an upload, its rows and its storage object, re-admitting from overlapping uploads
// the rows they held only through it (BE-03-T02).
const mongoose = require('mongoose');
const Upload = require('../../models/Upload.model');
const Transaction = require('../../models/Transaction.model');
const Cafe = require('../../models/Cafe.model');
const { invalidatePlanningForecasts: invalidateForecastInputs } = require('../../services/forecast.service');
const GeneratedInsight = require('../../models/GeneratedInsight.model');
const r2 = require('../../services/r2.service');
const ingestion = require('../../services/ingestion.service');
const { lockCafeMenu } = require('../../services/menuItems.service');
const { clearApiCache } = require('../../middleware/cache.middleware');
const { getCafeTimezone, STORAGE_CLEANUP_PENDING } = require('./shared');
const { recoverStaleParsingUpload } = require('./lease');
const { fillActualsForRange, invalidateAiInsights, recoverPendingUploadMaintenance } = require('./jobs');
const readmission = require('../../services/readmission.service');
const { activeCafeId } = require('../../utils/tenancy');

const remove = async (req, res, next) => {
  try {
    const stagedOnly = req.query?.stagedOnly;
    if (stagedOnly !== undefined && stagedOnly !== 'true') {
      return res.status(400).json({ success: false, message: 'stagedOnly must be true when supplied' });
    }
    const cafeId = activeCafeId(req);
    let upload = await Upload.findOne({ _id: req.params.id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    if (stagedOnly === 'true' && upload.status !== 'pending_mapping') {
      return res.status(409).json({ success: false, code: 'UPLOAD_NOT_STAGED',
        message: 'This upload is no longer waiting for mapping. Reload the page before making changes.' });
    }
    upload = await recoverStaleParsingUpload(upload, cafeId);

    const dateRange = upload.dateRange;
    const timezone = await getCafeTimezone(cafeId);
    // Rows another upload holds only through this one come back from that upload's own file (BE-03-T02). The
    // overlapping files are parsed here, outside the transaction; they are persisted inside it, after this upload's
    // rows are gone, so the delete never leaves a hole another upload should fill.
    const range = readmission.uploadDayRange(upload, timezone);
    const heldRows = await Transaction.exists({ cafeId, uploadId: upload._id });
    const plan = heldRows
      ? await readmission.prepareReadmission({ cafeId, range, excludeUploadId: upload._id, timezone })
      : { prepared: [], deferred: [], range };
    let outcome = { applied: [], stale: [] };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // First, so a menu edit or an import of this cafe waits for this delete rather than interleaving (BE-03-T12).
        await lockCafeMenu(cafeId, session);
        // Count what this upload actually contributed before removing it, rather
        // than trusting stats.imported - a re-map rewrites the rows without
        // rewriting the stat. An upload that contributed nothing (staged and
        // abandoned, or a duplicate that imported no new rows) changed none of the
        // model's inputs, so deleting it must not wipe the planning horizon or
        // invalidate insights. Doing so meant tidying up a stranded upload cost an
        // owner every forecast they had.
        const contributedRows = await Transaction.countDocuments({
          cafeId,
          uploadId: upload._id,
        }).session(session);

        if (contributedRows > 0) {
          await Transaction.deleteMany({ cafeId, uploadId: upload._id }).session(session);
          // Reassigned on every attempt: withTransaction may re-run this callback on a transient error.
          outcome = await readmission.applyReadmission({ prepared: plan.prepared, cafeId, session, timezone });
          await ingestion.rebuildItemsForCafe(cafeId, { session, pruneOrphans: true });
          await invalidateForecastInputs(cafeId, { timezone, session });
          await GeneratedInsight.updateOne(
            { cafeId },
            { $set: { invalidatedAt: new Date() } },
            { session }
          );
        }
        if (contributedRows > 0) {
          const remainingTransactions = await Transaction.countDocuments({ cafeId }).session(session);
          const cafeStateUpdate = remainingTransactions > 0
            ? { $set: { dataUploaded: true, lastSyncAt: new Date() } }
            : { $set: { dataUploaded: false }, $unset: { lastSyncAt: '' } };
          await Cafe.updateOne({ _id: cafeId }, cafeStateUpdate, { session });
        }
        const deletedUpload = await Upload.findOneAndUpdate(
          {
            _id: upload._id,
            cafeId,
            status: upload.status,
            updatedAt: upload.updatedAt,
          },
          {
            $set: {
              status: 'deleted',
              errorMessage: STORAGE_CLEANUP_PENDING,
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
          },
          { new: true, session }
        );
        if (!deletedUpload) {
          const error = new Error('Upload changed while deletion was starting. Please refresh and retry.');
          error.statusCode = 409;
          throw error;
        }
        upload = deletedUpload;
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }

    const queued = [...plan.deferred, ...outcome.stale];
    if (queued.length > 0) {
      await readmission.queueReadmission(queued, plan.range, upload._id);
      // Start the queue now rather than at the next sweep; the job is idempotent and claims atomically.
      runInBackground('upload_readmission_remove', () => {
        return recoverPendingUploadMaintenance({ limit: queued.length }).catch((error) => {
          logger.error('upload_readmission_kick_failed', logger.errorFields(error));
        });
      });
    }

    try { await fillActualsForRange(cafeId, dateRange, timezone); } catch (error) {
      logger.error('upload_delete_actuals_refresh_failed', logger.errorFields(error));
    }
    try {
      await r2.deleteFile(upload.r2Key);
      await Upload.updateOne(
        { _id: upload._id, status: 'deleted', errorMessage: STORAGE_CLEANUP_PENDING },
        {
          $set: { r2Key: `deleted/${upload._id}` },
          $unset: { errorMessage: '' },
        }
      );
    } catch (error) {
      logger.warn('upload_storage_cleanup_deferred', logger.errorFields(error));
    }

    try {
      await invalidateAiInsights(cafeId);
    } catch (error) {
      logger.error('upload_delete_insight_invalidation_failed', logger.errorFields(error));
    }
    clearApiCache({ cafeId });
    return res.status(200).json({
      success: true,
      readmitted: readmission.summariseReadmission(outcome.applied),
      readmissionQueued: queued.map(({ _id, fileName }) => ({ uploadId: _id, fileName })),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  remove,
};
