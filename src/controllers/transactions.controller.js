const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Upload = require('../models/Upload.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');
const parser = require('../services/parser.service');
const { addZonedDays, zonedDayEnd, zonedDayOrdinal, zonedDayStart, getCafeTimezone } = require('../utils/timezone');
const { proposeColumnMapping } = require('../services/anthropic.service');

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// The browser's claim is not evidence: a CSV sent as text/html was stored and later served as a web page
// (uploads-catalogue-19, security-17). By this point the bytes were validated for their extension, so the extension
// plus the magic bytes decide.
const storedContentType = (buffer, ext) => (ext === 'xlsx' && buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50
  ? XLSX_CONTENT_TYPE
  : 'text/csv; charset=utf-8');
// A code the product wrote for the client (LEGACY_XLS), carried on the upload's own 400 bodies (BE-03-T12).
const publicCodeOf = (err) => (err?.publicCode ? { code: err.publicCode } : {});
const { DEMAND_LINE_MATCH } = require('../utils/demand');
const { canSpendCredits } = require('../middleware/rbac.middleware');
const { activeCafeId } = require('../utils/tenancy');

const MIN_HEADER_COUNT = 2;
const MAX_TRANSACTION_QUERY_RANGE_DAYS = 5 * 366;
const MAX_TRANSACTION_PAGE = 10000;

const cleanupLocalFile = async (filePath) => {
  if (!filePath) return;
  try { await fs.promises.rm(filePath, { force: true }); } catch {}
};

const cleanColumnMapping = (mapping = {}, headers = []) => {
  const headerSet = new Set(headers);
  const cleaned = {};
  for (const [key, value] of Object.entries(mapping || {})) {
    if (typeof value === 'string' && headerSet.has(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
};

const hasRequiredHeaderMapping = (mapping = {}, headers = [], itemsMode = 'packed') =>
  parser.requiredFieldsForMode(itemsMode).every((field) => {
    const mappedHeader = mapping?.[field];
    return typeof mappedHeader === 'string' && headers.includes(mappedHeader);
  });

const sameHeaderSet = (a = [], b = []) => a.length === b.length && new Set([...a, ...b]).size === a.length;

/**
 * Whether a cafe's saved mapping may import this file without asking (BE-03-T05). Every column it names must be in
 * this file, the required fields must be covered, and, when we know the header row it was saved from, this file must
 * have that same set of headers. A mapping that half-fitted used to drop its missing columns in silence and
 * auto-import, so a till export that lost its Status column imported refunds as sales.
 */
const savedMappingFit = (saved, headers) => {
  if (!saved) return { status: 'none', missingColumns: [], mapping: {}, itemsMode: 'packed', coversRequired: false };
  const itemsMode = saved.itemsMode || 'packed';
  const named = parser.pickColumnMapping(saved);
  const missingColumns = [...new Set(Object.values(named).filter((column) => !headers.includes(column)))];
  const mapping = cleanColumnMapping(named, headers);
  const coversRequired = hasRequiredHeaderMapping(mapping, headers, itemsMode);
  const headersChanged = Array.isArray(saved.sourceHeaders) && saved.sourceHeaders.length > 0
    && !sameHeaderSet(saved.sourceHeaders, headers);
  if (missingColumns.length === 0 && !headersChanged && coversRequired) {
    return { status: 'applied', missingColumns, mapping, itemsMode, coversRequired };
  }
  let reason = 'incomplete'; // every column it names is here, but it never covered the required fields (line-per-row, no receipt)
  if (missingColumns.length > 0) reason = 'missing_columns';
  else if (headersChanged) reason = 'headers_changed';
  return { status: 'did_not_fit', reason, missingColumns, mapping, itemsMode, coversRequired };
};

const upload = async (req, res, next) => {
  let filePath;
  let stagedR2Key = null;
  let uploadDocCreated = false;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const cafeId = activeCafeId(req);
    const userId = req.user.id;
    filePath = req.file.path;
    const fileName = path.basename(req.file.originalname);
    const safeStorageName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload';
    const ext = path.extname(fileName).toLowerCase().slice(1);
    const buffer = await fs.promises.readFile(filePath);
    const fileFingerprint = crypto.createHash('sha256').update(buffer).digest('hex');

    // Validate size
    const maxBytes = typeof r2.maxObjectBytes === 'function'
      ? r2.maxObjectBytes()
      : 10 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      await cleanupLocalFile(filePath);
      return res.status(400).json({ success: false, message: `File exceeds ${maxBytes} bytes` });
    }

    // Preview headers + sample rows. previewBuffer validates the file first (empty, legacy .xls, archive safety), and
    // its 400s carry their message and code; validating here as well inflated a workbook twice more (BE-03-T13).
    let preview;
    try {
      preview = await ingestion.previewBuffer(buffer, ext);
    } catch (err) {
      await cleanupLocalFile(filePath);
      return res.status(400).json({
        success: false,
        ...publicCodeOf(err),
        message: err.statusCode === 400
          ? err.message
          : 'Could not read this file. Please upload a valid CSV or XLSX export.',
      });
    }

    const { headers, sampleRows } = preview;
    if (!headers || headers.length < MIN_HEADER_COUNT) {
      await cleanupLocalFile(filePath);
      return res.status(400).json({
        success: false,
        message: 'Could not find the column headings in this file. If it starts with a report title or a date range, '
          + 'delete those lines so the first line holds the column names, then upload it again.',
      });
    }

    // Stage to R2
    const r2Key = `uploads/${cafeId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeStorageName}`;
    try {
      await r2.uploadFile(buffer, r2Key, storedContentType(buffer, ext));
      stagedR2Key = r2Key;
    } catch (err) {
      await cleanupLocalFile(filePath);
      return res.status(503).json({ success: false, message: 'File storage unavailable, please retry' });
    }
    await cleanupLocalFile(filePath);

    // Detect format
    let posType, columnMapping, itemsMode;
    let usedSavedMapping = false;
    let savedMapping = { status: 'none', missingColumns: [] };
    let mappingAssistedByAi = false;
    let mappingCreditsUsed = 0;
    const cafe = await Cafe.findById(cafeId).lean();
    const yoco = ingestion.yocoMapping();
    if (ingestion.isYocoFormat(headers) && hasRequiredHeaderMapping(yoco.mapping, headers, yoco.itemsMode)) {
      posType = 'yoco';
      columnMapping = cleanColumnMapping(yoco.mapping, headers);
      itemsMode = yoco.itemsMode;
    } else {
      posType = 'wizard';
      const fit = savedMappingFit(cafe?.savedColumnMapping, headers);
      savedMapping = {
        status: fit.status,
        ...(fit.reason ? { reason: fit.reason } : {}),
        missingColumns: fit.missingColumns,
      };
      if (fit.status !== 'none' && (fit.coversRequired || fit.missingColumns.length === 0)) {
        // A fitting mapping imports as before. One that still covers date, items and total, or whose every column is
        // still in the file, is offered in the wizard with its own items mode: no AI credits are spent on a file the
        // cafe's own mapping nearly reads. Only a mapping that lost columns AND cannot cover the required fields asks
        // the AI (uploads-catalogue-21).
        columnMapping = fit.mapping;
        itemsMode = fit.itemsMode;
        usedSavedMapping = true;
      } else {
        const proposal = await proposeColumnMapping(headers, sampleRows, {
          orgId: req.user.orgId,
          cafeId,
          userId,
          allowPaidAi: canSpendCredits(req.user),
        });
        columnMapping = cleanColumnMapping(proposal.mapping, headers);
        itemsMode = proposal.itemsMode;
        mappingAssistedByAi = Object.keys(columnMapping).length > 0;
        mappingCreditsUsed = Number(proposal.aiCreditsCharged) || 0;
      }
    }

    const hasRequiredMapping = hasRequiredHeaderMapping(columnMapping, headers, itemsMode);

    // Record how we got here so the owner is told something true. A saved mapping or
    // an AI guess that did not yield the required fields did not map this file, and
    // labelling it 'Saved mapping' would credit a mapping that contributed nothing.
    // 'none' means the wizard is about to ask, and until it is answered this upload
    // has no mapping at all.
    const mappingSource = posType === 'yoco'
      ? 'yoco'
      : usedSavedMapping && hasRequiredMapping
        ? 'saved'
        : mappingAssistedByAi && hasRequiredMapping
          ? 'ai'
          : 'none';

    const uploadDoc = await Upload.create({
      cafeId,
      uploadedBy: userId,
      fileName,
      fileSize: buffer.length,
      r2Key,
      fileFingerprint,
      posType,
      mappingSource,
      columnMapping,
      itemsMode,
      headers,
      sampleRows,
      status: 'pending_mapping',
    });
    uploadDocCreated = true;


    return res.status(200).json({
      success: true,
      uploadId: uploadDoc._id,
      posType,
      mappingSource,
      columnMapping,
      itemsMode,
      headers,
      preview: sampleRows,
      needsConfirmation: posType !== 'yoco' && !(savedMapping.status === 'applied' && hasRequiredMapping),
      savedMapping,
      mappingAssistedByAi,
      mappingCreditsUsed,
    });
  } catch (error) {
    await cleanupLocalFile(filePath);
    if (stagedR2Key && !uploadDocCreated) {
      try { await r2.deleteFile(stagedR2Key); } catch {}
    }
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { startDate, endDate, limit = 100, page = 1 } = req.query;
    const timezone = await getCafeTimezone(cafeId);

    const query = { cafeId };

    if (startDate || endDate) {
      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate must be provided together',
        });
      }
      query.date = {};
      if (startDate) query.date.$gte = zonedDayStart(startDate, timezone);
      if (endDate) query.date.$lte = zonedDayEnd(endDate, timezone);
      if ((startDate && !query.date.$gte) || (endDate && !query.date.$lte)) {
        return res.status(400).json({ success: false, message: 'Invalid transaction date range' });
      }
      if (query.date.$gte && query.date.$lte) {
        const rangeDays = zonedDayOrdinal(query.date.$lte, timezone) -
          zonedDayOrdinal(query.date.$gte, timezone) + 1;
        if (rangeDays <= 0 || rangeDays > MAX_TRANSACTION_QUERY_RANGE_DAYS) {
          return res.status(400).json({
            success: false,
            message: `Transaction date range must be between 1 and ${MAX_TRANSACTION_QUERY_RANGE_DAYS} days`,
          });
        }
      }
    }

    const limitNum = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
    const pageNum = Math.max(1, Math.min(parseInt(page, 10) || 1, MAX_TRANSACTION_PAGE));
    const skip = (pageNum - 1) * limitNum;

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Transaction.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      transactions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
};

const getStats = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafeObjectId = new mongoose.Types.ObjectId(String(cafeId));
    const timezone = await getCafeTimezone(cafeId);

    const [result] = await Transaction.aggregate([
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
        },
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalTransactions: { $sum: 1 },
                totalRevenue: { $sum: { $ifNull: ['$total', 0] } },
                firstDate: { $min: '$date' },
                lastDate: { $max: '$date' },
              },
            },
          ],
          topItems: [
            { $unwind: '$items' },
            { $match: DEMAND_LINE_MATCH },
            {
              $group: {
                _id: '$items.name',
                qty: { $sum: { $ifNull: ['$items.quantity', 0] } },
              },
            },
            { $sort: { qty: -1 } },
            { $limit: 5 },
            {
              $project: {
                _id: 0,
                name: '$_id',
                qty: 1,
              },
            },
          ],
        },
      },
    ]);

    const totals = result?.totals?.[0];

    if (!totals) {
      return res.status(200).json({
        success: true,
        stats: {
          totalTransactions: 0,
          totalRevenue: 0,
          avgDailyRevenue: 0,
          topItems: [],
          firstDate: null,
          lastDate: null,
        },
      });
    }

    const totalRevenue = Number(totals.totalRevenue || 0);
    const firstDate = totals.firstDate;
    const lastDate = totals.lastDate;
    const dayCount = Math.max(
      zonedDayOrdinal(lastDate, timezone) - zonedDayOrdinal(firstDate, timezone) + 1,
      1
    );
    const avgDailyRevenue = totalRevenue / dayCount;

    return res.status(200).json({
      success: true,
      stats: {
        totalTransactions: totals.totalTransactions,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgDailyRevenue: parseFloat(avgDailyRevenue.toFixed(2)),
        topItems: result.topItems || [],
        firstDate,
        lastDate,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getDataStatus = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);

    // Find the latest transaction date (most recent data the user has)
    const latest = await Transaction.findOne({ cafeId }).sort({ date: -1 }).select('date').lean();
    const earliest = await Transaction.findOne({ cafeId }).sort({ date: 1 }).select('date').lean();
    const totalCount = await Transaction.countDocuments({ cafeId });

    // Coverage: the last 30 COMPLETED trading days plus today, so the portal can
    // show today separately. Today is in progress, not missing: a cafe that has
    // not sold anything yet this morning has left no gap, and counting it as one
    // reported a hole the owner could do nothing about. Thirty-one days back so
    // the oldest completed day the strip draws is still inside this window.
    const thirtyDaysAgo = addZonedDays(new Date(), -30, timezone);

    const coverage = await Transaction.aggregate([
      { $match: { cafeId: new mongoose.Types.ObjectId(String(cafeId)), date: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$date', timezone },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Number of days since latest data
    let daysSinceLatest = null;
    if (latest) {
      daysSinceLatest = Math.max(
        0,
        zonedDayOrdinal(new Date(), timezone) -
          zonedDayOrdinal(latest.date, timezone)
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        latestDataDate: latest?.date || null,
        earliestDataDate: earliest?.date || null,
        daysSinceLatest,
        totalTransactions: totalCount,
        coverage30d: coverage.map((c) => ({ date: c._id, count: c.count })),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { upload, getTransactions, getStats, getDataStatus };
