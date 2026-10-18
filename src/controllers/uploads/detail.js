const logger = require('../../utils/logger');
// GET /uploads/:id and its rows.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const Transaction = require('../../models/Transaction.model');
const r2 = require('../../services/r2.service');
const { MAX_LIST_PAGE } = require('./shared');
const { parsingLeaseMs } = require('./lease');
const { maintenanceMaxAttempts, claimAndRunPostImportMaintenance } = require('./jobs');
const { activeCafeId } = require('../../utils/tenancy');
const { getCafeTimezone } = require('../../utils/timezone');
const readmission = require('../../services/readmission.service');

const detail = async (req, res, next) => {
  try {
    const upload = await Upload.findOne({ _id: req.params.id, cafeId: activeCafeId(req) })
      .populate('uploadedBy', 'name email')
      .lean();
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    const maintenanceIsStale = upload.maintenance?.status === 'running' &&
      upload.maintenance?.startedAt &&
      new Date(upload.maintenance.startedAt) <= new Date(Date.now() - parsingLeaseMs());
    const maintenanceRetryIsDue = upload.maintenance?.status === 'partial_failure' &&
      Number(upload.maintenance?.attempts || 0) < maintenanceMaxAttempts() &&
      (
        !upload.maintenance?.nextRetryAt ||
        new Date(upload.maintenance.nextRetryAt) <= new Date()
      );
    if (upload.status === 'completed' && (
      upload.maintenance?.status === 'queued' || maintenanceIsStale || maintenanceRetryIsDue
    )) {
      setImmediate(() => {
        claimAndRunPostImportMaintenance(upload).catch((error) => {
          logger.error('upload_maintenance_recovery_failed', { trigger: 'request', ...logger.errorFields(error) });
        });
      });
    }
    const downloadUrl = await r2.getSignedDownloadUrl(upload.r2Key, 900, { fileName: upload.fileName });
    return res.status(200).json({ success: true, upload, downloadUrl });
  } catch (error) {
    next(error);
  }
};

const rows = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const upload = await Upload.findOne({ _id: req.params.id, cafeId }).lean();
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }

    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, MAX_LIST_PAGE));
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ cafeId, uploadId: upload._id })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({ cafeId, uploadId: upload._id }),
    ]);

    return res.status(200).json({
      success: true,
      transactions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

// GET /uploads/:id/overlaps: the completed uploads of this cafe whose days meet this one's, so the delete dialog can
// say which files keep those days covered. At most 20 are listed; `more` counts at most one beyond them (enough to say
// "and more").
const overlaps = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const upload = await Upload.findOne({ _id: req.params.id, cafeId }).select('_id status dateRange').lean();
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    const timezone = await getCafeTimezone(cafeId);
    const range = readmission.uploadDayRange(upload, timezone);
    if (!range) return res.status(200).json({ success: true, overlaps: [], more: 0 });
    const found = await readmission.findOverlappingUploads(cafeId, range, {
      excludeUploadId: upload._id, timezone, limit: readmission.MAX_LISTED_OVERLAPS + 1,
    });
    const listed = found.slice(0, readmission.MAX_LISTED_OVERLAPS);
    return res.status(200).json({
      success: true,
      overlaps: listed.map((row) => ({ uploadId: row._id, fileName: row.fileName, ...readmission.uploadDayRange(row, timezone) })),
      more: Math.max(0, found.length - listed.length),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  detail, rows, overlaps,
};
