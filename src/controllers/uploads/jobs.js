const { runInBackground } = require('../../utils/lifecycle');
const logger = require('../../utils/logger');
// The post-import job queue: forecast invalidation, actuals fill, insight invalidation, claim, run, schedule and recovery.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const { backgroundJobsInline } = require('../../config/flags');
const readmission = require('../../services/readmission.service');
const Upload = require('../../models/Upload.model');
const { updateForecastActualsForRange, generateWeekForecast, invalidatePlanningForecasts: invalidateForecastInputs } = require('../../services/forecast.service');
const { invalidateDerivedViews } = require('../../services/postImport.service');
const { boundedInteger, getCafeTimezone } = require('./shared');
const { parsingLeaseMs, MAX_PARSING_LEASE_MS } = require('./lease');

const DEFAULT_MAINTENANCE_RETRY_MS = 5 * 60 * 1000;
const MAX_MAINTENANCE_RETRY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_MAX_ATTEMPTS = 5;

const MAX_ACTUALS_REFRESH_FORECASTS = 366;

const maintenanceMaxAttempts = () => boundedInteger(
  process.env.UPLOAD_MAINTENANCE_MAX_ATTEMPTS,
  DEFAULT_MAINTENANCE_MAX_ATTEMPTS,
  1,
  10
);

const maintenanceRetryDelayMs = (attempts) => {
  const baseDelay = boundedInteger(
    process.env.UPLOAD_MAINTENANCE_RETRY_MS,
    DEFAULT_MAINTENANCE_RETRY_MS,
    1000,
    MAX_MAINTENANCE_RETRY_MS
  );
  return Math.min(
    MAX_MAINTENANCE_RETRY_MS,
    baseDelay * (2 ** Math.max(0, Number(attempts || 1) - 1))
  );
};

const invalidatePlanningForecasts = async (cafeId, timezone) => {
  return invalidateForecastInputs(cafeId, { timezone: timezone || await getCafeTimezone(cafeId) });
};

const fillActualsForRange = async (cafeId, dateRange, timezone) => {
  if (!dateRange?.firstDate || !dateRange?.lastDate) return;
  const resolvedTimezone = timezone || await getCafeTimezone(cafeId);
  const result = await updateForecastActualsForRange(cafeId, dateRange.firstDate, dateRange.lastDate, { timezone: resolvedTimezone });
  if (result.capped) {
    logger.warn('actuals_refresh_capped', { cafeId: String(cafeId), cap: MAX_ACTUALS_REFRESH_FORECASTS });
  }
};

const invalidateAiInsights = async (cafeId) => {
  try {
    const { invalidateInsights } = require('../../services/anthropic.service');
    if (typeof invalidateInsights === 'function') await invalidateInsights(cafeId);
  } catch (error) {
    throw new Error(`AI insight invalidation: ${error.message}`);
  }
};

const runPostImportMaintenance = async (claimedUpload, timezone) => {
  const uploadId = claimedUpload._id;
  const cafeId = claimedUpload.cafeId;
  const dateRange = claimedUpload.dateRange;
  const attemptCount = Number(claimedUpload.maintenance?.attempts || 1);
  const claimStartedAt = claimedUpload.maintenance?.startedAt;
  const errors = [];
  const safely = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      logger.error('upload_maintenance_step_failed', { step: label, ...logger.errorFields(error) });
      errors.push(`${label}: ${error.message}`.slice(0, 500));
    }
  };
  // First, so the forecast work that follows sees re-admitted rows (BE-03-T02). A failure leaves the re-read pending.
  await safely('re-admission', () => readmission.runPendingReadmission(uploadId, timezone));
  await safely('forecast invalidation', () => invalidatePlanningForecasts(cafeId, timezone));
  await safely('week forecast regeneration', () => generateWeekForecast(cafeId));
  await safely('forecast actuals refresh', () => fillActualsForRange(cafeId, dateRange, timezone));
  await safely('AI insight invalidation', () => invalidateDerivedViews(cafeId));

  const maxAttempts = maintenanceMaxAttempts();
  const canRetry = errors.length > 0 && attemptCount < maxAttempts;
  const completedAt = new Date();
  const update = {
    $set: {
      'maintenance.status': errors.length === 0 ? 'completed' : 'partial_failure',
      'maintenance.completedAt': completedAt,
      'maintenance.errors': errors,
    },
    $unset: {
      'maintenance.nextRetryAt': '',
      'maintenance.retryExhaustedAt': '',
    },
  };
  if (canRetry) {
    update.$set['maintenance.nextRetryAt'] = new Date(
      completedAt.getTime() + maintenanceRetryDelayMs(attemptCount)
    );
    delete update.$unset['maintenance.nextRetryAt'];
  } else if (errors.length > 0) {
    update.$set['maintenance.retryExhaustedAt'] = completedAt;
    delete update.$unset['maintenance.retryExhaustedAt'];
  }

  await Upload.updateOne(
    {
      _id: uploadId,
      cafeId,
      status: 'completed',
      'maintenance.status': 'running',
      'maintenance.startedAt': claimStartedAt,
    },
    update
  );
  return errors;
};

const claimPostImportMaintenance = async (candidate) => {
  const now = new Date();
  const maxAttempts = maintenanceMaxAttempts();
  const query = {
    _id: candidate._id,
    cafeId: candidate.cafeId,
    status: 'completed',
    'maintenance.status': candidate.maintenance?.status || 'queued',
    $and: [{
      $or: [
        { 'maintenance.attempts': { $exists: false } },
        { 'maintenance.attempts': { $lt: maxAttempts } },
      ],
    }],
  };
  if (candidate.maintenance?.status === 'running' && candidate.maintenance?.startedAt) {
    query['maintenance.startedAt'] = candidate.maintenance.startedAt;
  }
  if (candidate.maintenance?.status === 'partial_failure') {
    query.$and.push({
      $or: [
        { 'maintenance.nextRetryAt': { $exists: false } },
        { 'maintenance.nextRetryAt': { $lte: now } },
      ],
    });
  }
  return Upload.findOneAndUpdate(
    query,
    {
      $set: {
        'maintenance.status': 'running',
        'maintenance.startedAt': now,
        'maintenance.errors': [],
      },
      $inc: { 'maintenance.attempts': 1 },
      $unset: {
        'maintenance.completedAt': '',
        'maintenance.nextRetryAt': '',
        'maintenance.retryExhaustedAt': '',
      },
    },
    { new: true }
  );
};

const claimAndRunPostImportMaintenance = async (candidate, timezone) => {
  const claimed = await claimPostImportMaintenance(candidate);
  if (!claimed) return false;
  const resolvedTimezone = timezone || await getCafeTimezone(claimed.cafeId);
  const errors = await runPostImportMaintenance(claimed, resolvedTimezone);
  return { status: errors.length === 0 ? 'completed' : 'partial_failure', errors };
};

const schedulePostImportMaintenance = async (uploadId, cafeId, dateRange, timezone) => {
  const candidate = {
    _id: uploadId,
    cafeId,
    dateRange,
    maintenance: { status: 'queued' },
  };
  if (backgroundJobsInline()) {
    await claimAndRunPostImportMaintenance(candidate, timezone);
    return;
  }
  runInBackground('post_import_maintenance', () => {
    return claimAndRunPostImportMaintenance(candidate, timezone).catch((error) => {
      logger.error('upload_maintenance_failed', { uploadId: String(uploadId), ...logger.errorFields(error) });
    });
  });
};

const recoverPendingUploadMaintenance = async ({
  limit = 10,
  staleAfterMs = parsingLeaseMs(),
} = {}) => {
  const batchLimit = boundedInteger(limit, 10, 1, 50);
  const maxAttempts = maintenanceMaxAttempts();
  const now = new Date();
  const staleBefore = new Date(Date.now() - boundedInteger(
    staleAfterMs,
    parsingLeaseMs(),
    60 * 1000,
    MAX_PARSING_LEASE_MS
  ));
  await Upload.updateMany(
    {
      status: 'completed',
      'maintenance.status': 'running',
      'maintenance.startedAt': { $lte: staleBefore },
      'maintenance.attempts': { $gte: maxAttempts },
    },
    {
      $set: {
        'maintenance.status': 'partial_failure',
        'maintenance.completedAt': now,
        'maintenance.retryExhaustedAt': now,
        'maintenance.errors': [
          `Maintenance stopped after ${maxAttempts} interrupted attempts; manual review is required.`,
        ],
      },
      $unset: { 'maintenance.nextRetryAt': '' },
    }
  );
  const candidates = await Upload.find({
    status: 'completed',
    // Implied by the $or below; stated so the planner can use the partial maintenance index rather than read every
    // completed upload of every tenant (BE-03-T13).
    'maintenance.status': { $in: ['queued', 'running', 'partial_failure'] },
    $and: [
      {
        $or: [
          { 'maintenance.attempts': { $exists: false } },
          { 'maintenance.attempts': { $lt: maxAttempts } },
        ],
      },
      {
        $or: [
          { 'maintenance.status': 'queued' },
          {
            'maintenance.status': 'running',
            'maintenance.startedAt': { $lte: staleBefore },
          },
          {
            'maintenance.status': 'partial_failure',
            $or: [
              { 'maintenance.nextRetryAt': { $exists: false } },
              { 'maintenance.nextRetryAt': { $lte: now } },
            ],
          },
        ],
      },
    ],
  })
    .select('_id cafeId dateRange maintenance')
    .sort({ updatedAt: 1 })
    .limit(batchLimit)
    .lean();

  const summary = { scanned: candidates.length, completed: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const result = await claimAndRunPostImportMaintenance(candidate);
      if (result?.status === 'completed') summary.completed++;
      if (result?.status === 'partial_failure') summary.failed++;
    } catch (error) {
      summary.failed++;
      logger.error('upload_maintenance_recovery_failed', { trigger: 'sweep', ...logger.errorFields(error) });
    }
  }
  return summary;
};

module.exports = {
  maintenanceMaxAttempts, maintenanceRetryDelayMs, invalidatePlanningForecasts, fillActualsForRange, invalidateAiInsights, runPostImportMaintenance,
  claimPostImportMaintenance, claimAndRunPostImportMaintenance, schedulePostImportMaintenance, recoverPendingUploadMaintenance,
};
