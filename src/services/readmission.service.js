const logger = require('../utils/logger');
const mongoose = require('mongoose');
const Upload = require('../models/Upload.model');
const r2 = require('./r2.service');
const parser = require('./parser.service');
const ingestion = require('./ingestion.service');
const { zonedDateKey, zonedDayStart, zonedDayEnd } = require('../utils/timezone');

/**
 * Re-admission (BE-03-T02). When upload B is confirmed, rows it shares with an earlier upload A are skipped as
 * duplicates, so they exist only under A. Deleting or remapping A used to drop them for good. Now, once A's rows
 * are gone, every other completed upload of the cafe whose days meet A's is re-read from its own stored file with
 * its own mapping, filtered to A's days, and persisted through the normal identity dedupe: only the rows the cafe
 * no longer holds come back, under that upload's id. Up to a request budget this happens inside the delete's
 * transaction; the rest goes to the post-import maintenance queue (claim, retry, recovery already exist there).
 */
const DEFAULT_SYNC_MAX_UPLOADS = 8;
const HARD_SYNC_MAX_UPLOADS = 20;
const DEFAULT_SYNC_MAX_ROWS = 50000;
const HARD_SYNC_MAX_ROWS = 200000;
const MAX_LISTED_OVERLAPS = 20;
const SELECT = '_id cafeId fileName r2Key columnMapping itemsMode dateRange completedAt';

const readmissionLimits = () => ({
  maxUploads: parser.boundedInteger(process.env.UPLOAD_READMIT_SYNC_MAX_UPLOADS, DEFAULT_SYNC_MAX_UPLOADS, 0, HARD_SYNC_MAX_UPLOADS),
  maxRows: parser.boundedInteger(process.env.UPLOAD_READMIT_SYNC_MAX_ROWS, DEFAULT_SYNC_MAX_ROWS, 0, HARD_SYNC_MAX_ROWS),
});

/** The cafe-local days an upload covers, or null when it never imported anything. */
const uploadDayRange = (upload, timezone) => {
  const range = upload?.dateRange || {};
  const firstDateKey = range.firstDateKey || (range.firstDate ? zonedDateKey(range.firstDate, timezone) : null);
  const lastDateKey = range.lastDateKey || (range.lastDate ? zonedDateKey(range.lastDate, timezone) : null);
  return firstDateKey && lastDateKey ? { firstDateKey, lastDateKey } : null;
};

const unionDayRange = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return {
    firstDateKey: a.firstDateKey < b.firstDateKey ? a.firstDateKey : b.firstDateKey,
    lastDateKey: a.lastDateKey > b.lastDateKey ? a.lastDateKey : b.lastDateKey,
  };
};

/** Completed uploads of this cafe (never another) whose dates meet `range`, oldest commit first. */
const findOverlappingUploads = (cafeId, range, { excludeUploadId, timezone, limit } = {}) => {
  let query = Upload.find({
    cafeId,
    _id: { $ne: excludeUploadId },
    status: 'completed',
    'dateRange.firstDate': { $lte: zonedDayEnd(range.lastDateKey, timezone) },
    'dateRange.lastDate': { $gte: zonedDayStart(range.firstDateKey, timezone) },
  }).select(SELECT).sort({ completedAt: 1, _id: 1 });
  if (limit) query = query.limit(limit);
  return query.lean();
};

/** Re-reads one upload's stored file with its stored mapping and keeps only the rows on `range`'s days. */
const parseWithinRange = async (upload, range, timezone) => {
  const buffer = await r2.downloadFile(upload.r2Key);
  if (!Buffer.isBuffer(buffer)) throw new Error(`Stored file for upload ${upload._id} is unavailable`);
  const fileExt = String(upload.fileName || '').split('.').pop().toLowerCase();
  // The same bounded worker as confirm: deletes and remaps can re-read thousands of stored rows.
  const parsed = await parser.parseBuffer(buffer, {
    columnMapping: upload.columnMapping, itemsMode: upload.itemsMode, fileExt, timezone, isolate: true,
  });
  const rows = parsed.rows.filter((row) => row.dateKey >= range.firstDateKey && row.dateKey <= range.lastDateKey);
  return { upload, parsedRows: parsed.totalRows, parsed: { ...parsed, rows, errors: 0, rowErrors: [], totalRows: rows.length } };
};

/**
 * Before a delete or remap commits: parse, outside any transaction, every overlapping upload the request budget
 * allows. Whatever does not fit the budget or cannot be read is returned as `deferred`, for the queue.
 */
const prepareReadmission = async ({ cafeId, range, excludeUploadId, timezone }) => {
  if (!range) return { prepared: [], deferred: [], range: null };
  const limits = readmissionLimits();
  const candidates = await findOverlappingUploads(cafeId, range, { excludeUploadId, timezone });
  const prepared = [];
  const deferred = [];
  let parsedRows = 0;
  for (const candidate of candidates) {
    if (prepared.length >= limits.maxUploads || parsedRows >= limits.maxRows) {
      deferred.push(candidate);
      continue;
    }
    try {
      const entry = await parseWithinRange(candidate, range, timezone);
      parsedRows += entry.parsedRows;
      prepared.push(entry);
    } catch (error) {
      logger.error('upload_readmission_failed', { uploadId: String(candidate._id), ...logger.errorFields(error) });
      deferred.push(candidate);
    }
  }
  return { prepared, deferred, range };
};

/**
 * Inside the caller's transaction, after the deleted or remapped upload's rows are gone: persist each prepared
 * upload's rows through the normal identity dedupe, so only rows the cafe no longer holds come back.
 * An upload re-committed or being re-parsed since it was parsed is returned as `stale` for the queue.
 */
const applyReadmission = async ({ prepared, cafeId, session, timezone }) => {
  const applied = [];
  const stale = [];
  for (const { upload, parsed } of prepared) {
    // completedAt moves only when the upload's rows are committed again (confirm or remap), and status leaves
    // 'completed' while it is re-parsed. updatedAt would also move on every background maintenance write, which
    // turned a delete made just after confirming the overlapping upload into a needless queued re-read.
    const unchanged = await Upload.exists({
      _id: upload._id, cafeId, status: 'completed', completedAt: upload.completedAt,
    }).session(session);
    if (!unchanged) {
      stale.push(upload);
      continue;
    }
    if (parsed.rows.length === 0) continue;
    await ingestion.reconcileParsedRows(parsed, { cafeId, session });
    const result = await ingestion.persistParsedRows(parsed, {
      cafeId,
      uploadId: upload._id,
      session,
      itemsAlreadyReconciled: true,
      rebuildItems: false,
      failOnPersistenceError: true,
      timezone,
    });
    if (result.imported === 0) continue;
    // The rows came back because the upload that held them is gone: they were skipped as duplicates, so they leave
    // that reason too, and skipped stays the sum of its reasons (BE-03-T09).
    await Upload.updateOne({ _id: upload._id, cafeId }, [{
      $set: {
        'stats.imported': { $add: [{ $ifNull: ['$stats.imported', 0] }, result.imported] },
        'stats.skipped': { $max: [0, { $subtract: [{ $ifNull: ['$stats.skipped', 0] }, result.imported] }] },
        'stats.skippedByReason.duplicate': {
          $max: [0, { $subtract: [{ $ifNull: ['$stats.skippedByReason.duplicate', 0] }, result.imported] }],
        },
      },
    }], { session });
    applied.push({ uploadId: upload._id, fileName: upload.fileName, rows: result.imported });
  }
  return { applied, stale };
};

/** Hands uploads to the post-import maintenance queue, merging with any range it already owes. */
const queueReadmission = async (uploads, range, sourceUploadId) => {
  for (const upload of uploads) {
    const pending = { $eq: ['$readmission.status', 'pending'] };
    await Upload.updateOne({ _id: upload._id, status: 'completed' }, [{
      $set: {
        readmission: {
          status: 'pending',
          firstDateKey: { $cond: [pending, { $min: ['$readmission.firstDateKey', range.firstDateKey] }, range.firstDateKey] },
          lastDateKey: { $cond: [pending, { $max: ['$readmission.lastDateKey', range.lastDateKey] }, range.lastDateKey] },
          sourceUploadId: { $literal: sourceUploadId },
          requestedAt: '$$NOW',
        },
        'maintenance.status': 'queued',
        'maintenance.attempts': 0,
      },
    }, { $unset: ['maintenance.nextRetryAt', 'maintenance.retryExhaustedAt'] }]);
  }
};

/** Run by the maintenance job for an upload that owes a re-read. Idempotent: identity dedupe skips what is held. */
const runPendingReadmission = async (uploadId, timezone) => {
  const upload = await Upload.findOne({ _id: uploadId, status: 'completed', 'readmission.status': 'pending' })
    .select(`${SELECT} readmission`).lean();
  if (!upload) return { rows: 0 };
  const range = { firstDateKey: upload.readmission.firstDateKey, lastDateKey: upload.readmission.lastDateKey };
  const entry = await parseWithinRange(upload, range, timezone);
  let rows = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const outcome = await applyReadmission({ prepared: [entry], cafeId: upload.cafeId, session, timezone });
      if (outcome.stale.length > 0) throw new Error('Upload changed during re-admission; the queue will retry');
      rows = outcome.applied[0]?.rows || 0;
      await ingestion.rebuildItemsForCafe(upload.cafeId, { session, pruneOrphans: true });
      await Upload.updateOne(
        { _id: upload._id, 'readmission.status': 'pending', 'readmission.requestedAt': upload.readmission.requestedAt },
        { $set: { 'readmission.status': 'completed', 'readmission.completedAt': new Date(), 'readmission.rows': rows } },
        { session }
      );
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally {
    await session.endSession();
  }
  return { rows };
};

const summariseReadmission = (applied = []) => ({
  rows: applied.reduce((sum, entry) => sum + entry.rows, 0),
  uploads: applied.map(({ uploadId, fileName, rows }) => ({ uploadId, fileName, rows })),
});

module.exports = {
  MAX_LISTED_OVERLAPS,
  applyReadmission,
  findOverlappingUploads,
  prepareReadmission,
  queueReadmission,
  runPendingReadmission,
  summariseReadmission,
  unionDayRange,
  uploadDayRange,
};
