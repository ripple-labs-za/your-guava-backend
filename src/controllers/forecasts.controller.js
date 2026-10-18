const mongoose = require('mongoose');
const Forecast = require('../models/Forecast.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const Transaction = require('../models/Transaction.model');
const {
  FORECAST_MODEL_VERSION,
  generateForecast,
  updateForecastActuals,
} = require('../services/forecast.service');
const { clearApiCache } = require('../middleware/cache.middleware');
const {
  DEFAULT_FORECAST_SETTINGS,
  applyForecastSettingsUpdate,
  getFactorEntitlements,
  getForecastSettings,
  getSavedForecastSettings,
} = require('../services/forecastFactors.service');
const {
  addZonedDays,
  safeTimezone,
  zonedDateKey,
  zonedDayStart,
  getCafeTimezone,
} = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');

const REQUIRED_PLANNING_FACTOR_KEYS = ['weather', 'loadShedding', 'holiday', 'payday', 'events'];
const HISTORY_BACKFILL_BATCH_SIZE = 14;
// Live scored days needed before the headline accuracy stops leaning on
// backtests. Five is a working week: enough that one bad Saturday cannot move
// the figure twenty points. See DECISIONS D-004.
const LIVE_ACCURACY_MIN_DAYS = 5;

const clampHistoryDays = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 90;
  return Math.max(1, Math.min(366, parsed));
};

const parseRequestedDay = (value, timezone) => {
  if (!value) return null;
  const parsed = zonedDayStart(value, timezone);
  if (parsed) return parsed;
  const error = new Error('Invalid date');
  error.statusCode = 400;
  throw error;
};

const hasMatchedActuals = (forecast) =>
  (forecast.items || []).some((item) => item.actualQty != null) ||
  forecast.actualsUpdatedAt != null ||
  forecast.actualTransactionCount != null ||
  forecast.accuracy != null;

const hasPlanningFactorPayload = (forecast) => {
  const factors = forecast?.factors || [];
  if (!Array.isArray(factors)) return false;

  const factorKeys = new Set(factors.map((factor) => factor?.key).filter(Boolean));
  if (!REQUIRED_PLANNING_FACTOR_KEYS.every((key) => factorKeys.has(key))) return false;

  if (!forecast.factorSettings || !forecast.factorEntitlements || !forecast.calibration) return false;
  if (forecast.calibration.sampleSize == null || forecast.calibration.overallMultiplier == null) return false;

  return (forecast.items || []).every((item) => Array.isArray(item.factors) && item.factors.length > 0);
};

const needsPlanningRefresh = (forecast, timezone) => {
  if (!forecast) return true;
  if (hasMatchedActuals(forecast)) return true;
  if (forecast.modelVersion !== FORECAST_MODEL_VERSION) return true;
  const generatedDateKey = forecast.generatedAt
    ? zonedDateKey(forecast.generatedAt, timezone)
    : null;
  if (generatedDateKey !== zonedDateKey(new Date(), timezone)) return true;
  return !hasPlanningFactorPayload(forecast);
};

const needsHistoryForecastRefresh = (forecast) => {
  if (!forecast) return true;
  // Never rewrite an original live/manual historical snapshot. Backfills are
  // explicitly marked and may be refreshed without corrupting live audit data.
  if ((forecast.origin || 'live') !== 'backfill') return false;
  if (forecast.totalPredictedRevenue == null) return true;
  return !hasPlanningFactorPayload(forecast);
};

const forecastForApi = (forecast, timezone) => {
  if (!forecast) return forecast;
  const value = typeof forecast.toObject === 'function' ? forecast.toObject() : { ...forecast };
  return {
    ...value,
    dateKey: value.dateKey || zonedDateKey(value.date, timezone),
    origin: value.origin || 'live',
    modelVersion: value.modelVersion || 'legacy',
  };
};

const revenueAccuracy = (predicted, actual) => {
  if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(predicted)) return null;
  return parseFloat(Math.max(0, (1 - Math.abs(actual - predicted) / actual) * 100).toFixed(1));
};

const summarizeHistoryAccuracy = (rows) => {
  const accuracyRows = rows.filter((row) => row.revenueAccuracy != null);
  const totalPredictedRevenue = rows.reduce((sum, row) => sum + row.predictedRevenue, 0);
  const totalActualRevenue = rows.reduce((sum, row) => sum + row.actualRevenue, 0);
  const variance = totalActualRevenue - totalPredictedRevenue;

  return {
    rowCount: rows.length,
    overallRevenueAccuracy: revenueAccuracy(totalPredictedRevenue, totalActualRevenue),
    avgDailyRevenueAccuracy: accuracyRows.length > 0
      ? parseFloat((accuracyRows.reduce((sum, row) => sum + row.revenueAccuracy, 0) / accuracyRows.length).toFixed(1))
      : null,
    totalPredictedRevenue: parseFloat(totalPredictedRevenue.toFixed(2)),
    totalActualRevenue: parseFloat(totalActualRevenue.toFixed(2)),
    variance: parseFloat(variance.toFixed(2)),
    variancePct: totalPredictedRevenue > 0
      ? parseFloat(((variance / totalPredictedRevenue) * 100).toFixed(1))
      : null,
  };
};

const buildHistoryRow = (forecast, actual = {}, timezone) => {
  const predictedRevenue = Number(forecast.totalPredictedRevenue || 0);
  const actualRevenue = Number(actual.actualRevenue ?? forecast.actualRevenue ?? 0);
  const variance = parseFloat((actualRevenue - predictedRevenue).toFixed(2));
  const variancePct =
    predictedRevenue > 0 ? parseFloat(((variance / predictedRevenue) * 100).toFixed(1)) : null;
  const activeFactors = (forecast.factors || []).filter((factor) => factor.active);

  return {
    forecastId: forecast._id,
    date: forecast.date,
    dateKey: forecast.dateKey || zonedDateKey(forecast.date, timezone),
    origin: forecast.origin || 'live',
    modelVersion: forecast.modelVersion || 'legacy',
    trainingCutoff: forecast.trainingCutoff || forecast.date,
    predictedRevenue,
    actualRevenue,
    variance,
    variancePct,
    revenueAccuracy: revenueAccuracy(predictedRevenue, actualRevenue),
    itemAccuracy: forecast.accuracy ?? null,
    transactionCount: actual.transactionCount ?? forecast.actualTransactionCount ?? 0,
    weather: forecast.signals?.weather || null,
    signals: {
      isPublicHoliday: Boolean(forecast.signals?.isPublicHoliday),
      isSchoolHoliday: Boolean(forecast.signals?.isSchoolHoliday),
      isPayday: Boolean(forecast.signals?.isPayday),
      loadSheddingStage: Number.isFinite(forecast.signals?.loadSheddingStage)
        ? forecast.signals.loadSheddingStage
        : null,
      loadSheddingAvailable: forecast.signals?.loadSheddingAvailable ?? null,
      loadSheddingUnavailableReason:
        forecast.signals?.loadSheddingUnavailableReason ?? null,
      events: forecast.signals?.events || [],
    },
    activeFactors,
    factorSummary: activeFactors.map((factor) => ({
      key: factor.key,
      label: factor.label,
      effect: factor.effect,
      adjustmentPct: factor.adjustmentPct,
    })),
    calibration: forecast.calibration,
    trainingData: forecast.trainingData,
    generatedAt: forecast.generatedAt,
    actualsUpdatedAt: forecast.actualsUpdatedAt,
  };
};

const ensureHistoryForecast = async (cafeId, date) => {
  let forecast = await Forecast.findOne({ cafeId, date });
  if (!forecast || ((forecast.origin || 'live') === 'backfill' && needsHistoryForecastRefresh(forecast))) {
    forecast = await generateForecast(cafeId, date, { origin: 'backfill' });
  }
  const updated = await updateForecastActuals(cafeId, date);
  return updated || forecast;
};

const getToday = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);
    const today = zonedDayStart(new Date(), timezone);

    let forecast = await Forecast.findOne({ cafeId, date: today });

    if (needsPlanningRefresh(forecast, timezone)) {
      forecast = await generateForecast(cafeId, today, { origin: 'live' });
    }

    return res.status(200).json({ success: true, forecast: forecastForApi(forecast, timezone) });
  } catch (error) {
    next(error);
  }
};

const getWeek = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);
    const today = zonedDayStart(new Date(), timezone);
    const nextWeek = addZonedDays(today, 7, timezone);

    const existing = await Forecast.find({
      cafeId,
      date: { $gte: today, $lt: nextWeek },
    }).sort({ date: 1 });

    const existingByDate = new Map(
      existing.map((forecast) => [zonedDateKey(forecast.date, timezone), forecast])
    );
    const targetDates = Array.from(
      { length: 7 },
      (_, index) => addZonedDays(today, index, timezone)
    );
    // Resilient: a transient failure on one day still returns the other days.
    const settled = await Promise.allSettled(
      targetDates.map(async (targetDate) => {
        const existingForecast = existingByDate.get(zonedDateKey(targetDate, timezone));
        if (existingForecast && !needsPlanningRefresh(existingForecast, timezone)) {
          return existingForecast;
        }
        return generateForecast(cafeId, targetDate, { origin: 'live' });
      })
    );
    const forecasts = settled
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => forecastForApi(result.value, timezone));
    const failures = settled.flatMap((result, index) => (
      result.status === 'rejected'
        ? [{
            dateKey: zonedDateKey(targetDates[index], timezone),
            message: result.reason?.message || 'Forecast generation failed',
          }]
        : []
    ));
    const insufficientDays = forecasts
      .filter((forecast) => forecast.availability?.status === 'insufficient_data')
      .map((forecast) => forecast.dateKey);

    settled
      .filter((result) => result.status === 'rejected')
      .forEach((result) => console.error('[forecasts] week day generation failed:', result.reason?.message));

    return res.status(200).json({
      success: true,
      forecasts,
      meta: {
        expectedDays: 7,
        generatedDays: forecasts.length,
        failedDays: failures,
        isPartial: failures.length > 0 || forecasts.length !== 7,
        insufficientData: insufficientDays.length > 0,
        insufficientDays,
      },
    });
  } catch (error) {
    next(error);
  }
};

const generate = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { date } = req.body;

    if (!date) {
      return res.status(400).json({ success: false, message: 'date is required' });
    }

    const timezone = await getCafeTimezone(cafeId);
    const targetDate = parseRequestedDay(date, timezone);
    const forecast = await generateForecast(cafeId, targetDate, { origin: 'manual' });
    clearApiCache({ cafeId });
    return res.status(200).json({
      success: true,
      forecast: forecastForApi(forecast, timezone),
    });
  } catch (error) {
    next(error);
  }
};

const getFactors = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(activeCafeId(req)).lean();
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });
    const org = await Organization.findById(req.user.orgId).lean();
    const plan = org?.plan || 'starter';
    const effective = getForecastSettings(cafe, plan);

    return res.status(200).json({
      success: true,
      defaults: DEFAULT_FORECAST_SETTINGS,
      // `settings` is the plan-clamped view the Factors page edits. `effective`
      // is the same view under its honest name, so a UI can show what the
      // forecast will actually use next to what is stored in `savedSettings`.
      settings: effective,
      effective,
      savedSettings: getSavedForecastSettings(cafe),
      entitlements: getFactorEntitlements(plan),
    });
  } catch (error) {
    next(error);
  }
};

const updateFactors = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(activeCafeId(req));
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });
    const org = await Organization.findById(req.user.orgId).lean();
    const plan = org?.plan || 'starter';

    const { settings: savedSettings, lockedChange } = applyForecastSettingsUpdate(
      cafe,
      req.body.settings || req.body || {},
      plan
    );
    if (lockedChange) {
      return res.status(402).json({
        success: false,
        code: 'PLAN_UPGRADE_REQUIRED',
        factor: lockedChange.key,
        requiredPlan: lockedChange.requiredPlan,
        message: lockedChange.message,
      });
    }
    cafe.forecastSettings = savedSettings;
    await cafe.save();

    const today = zonedDayStart(new Date(), safeTimezone(cafe.timezone));
    await Forecast.deleteMany({ cafeId: cafe._id, date: { $gte: today } });
    clearApiCache({ cafeId: cafe._id });

    const effective = getForecastSettings(cafe, plan);
    return res.status(200).json({
      success: true,
      settings: effective,
      effective,
      savedSettings,
      entitlements: getFactorEntitlements(plan),
    });
  } catch (error) {
    next(error);
  }
};

const getAccuracy = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);
    const today = zonedDayStart(new Date(), timezone);
    const thirtyDaysAgo = addZonedDays(today, -30, timezone);

    const scored = await Forecast.find({
      cafeId,
      date: { $gte: thirtyDaysAgo, $lt: today },
      accuracy: { $exists: true, $ne: null },
      actualsUpdatedAt: { $exists: true, $ne: null },
    })
      .sort({ date: -1 })
      .select('date dateKey origin modelVersion accuracy totalPredictedRevenue actualRevenue actualTransactionCount actualsUpdatedAt')
      .lean();

    // A backfilled day was scored against sales the model had not seen, so it
    // is a real measurement -- just a retrospective one. Anything that is not
    // a backfill is live, including older documents written before `origin`
    // existed and the occasional manual regeneration.
    const live = scored.filter((forecast) => forecast.origin !== 'backfill');
    const backtest = scored.filter((forecast) => forecast.origin === 'backfill');

    // Under five live days the figure swings twenty points on one bad
    // Saturday, so claiming it is live would make the headline less reliable
    // the moment it started saying so. A new cafe that has run a backfill sees
    // the backtest estimate instead of a blank screen (DECISIONS D-004).
    const basis = live.length >= LIVE_ACCURACY_MIN_DAYS
      ? 'live'
      : backtest.length > 0
        ? 'backtest'
        : 'none';
    const chosen = basis === 'live' ? live : basis === 'backtest' ? backtest : [];

    const avgAccuracy =
      chosen.length > 0
        ? chosen.reduce((sum, f) => sum + f.accuracy, 0) / chosen.length
        : null;

    // The day live scoring starts, so the UI can say what the estimate will be
    // replaced by and when.
    const earliestLive = live.length > 0 ? live[live.length - 1] : null;

    return res.status(200).json({
      success: true,
      avgAccuracy: avgAccuracy !== null ? parseFloat(avgAccuracy.toFixed(1)) : null,
      basis,
      liveCount: live.length,
      backtestCount: backtest.length,
      liveFrom: earliestLive ? new Date(earliestLive.date).toISOString() : null,
      forecasts: chosen.map((forecast) => forecastForApi(forecast, timezone)),
    });
  } catch (error) {
    next(error);
  }
};

const getHistory = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafeObjectId = new mongoose.Types.ObjectId(String(cafeId));
    const cafe = await Cafe.findOne({ _id: cafeId, orgId: req.user.orgId })
      .select('timezone')
      .lean();
    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }
    const timezone = safeTimezone(cafe.timezone);
    const days = clampHistoryDays(req.query.days);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 30));
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const syncBackfillLimit =
      req.query.backfill === 'sync'
        ? Math.max(1, Math.min(HISTORY_BACKFILL_BATCH_SIZE, Number.parseInt(req.query.backfillLimit, 10) || 1))
        : 0;
    const yesterday = addZonedDays(new Date(), -1, timezone);
    const requestedEnd = parseRequestedDay(req.query.endDate, timezone) || yesterday;
    const endDay = requestedEnd > yesterday ? yesterday : requestedEnd;
    const requestedStart = parseRequestedDay(req.query.startDate, timezone);
    const startDay = requestedStart || addZonedDays(endDay, -(days - 1), timezone);
    const endExclusive = addZonedDays(endDay, 1, timezone);

    if (startDay > endDay) {
      return res.status(400).json({ success: false, message: 'startDate must be before endDate' });
    }

    const actuals = await Transaction.aggregate([
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: startDay, $lt: endExclusive },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$date',
              timezone,
            },
          },
          actualRevenue: { $sum: { $ifNull: ['$total', 0] } },
          transactionCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const dateKeys = actuals.map((entry) => entry._id).slice(-366);
    const actualByDate = new Map(
      actuals.map((entry) => [
        entry._id,
        {
          actualRevenue: parseFloat(Number(entry.actualRevenue || 0).toFixed(2)),
          transactionCount: entry.transactionCount || 0,
        },
      ])
    );

    const forecasts = await Forecast.find({
      cafeId,
      date: { $gte: startDay, $lt: endExclusive },
    })
      .lean();

    const forecastByDate = new Map(
      forecasts.map((forecast) => [zonedDateKey(forecast.date, timezone), forecast])
    );
    let generated = 0;
    let missingDateKeys = dateKeys.filter((dateKey) => needsHistoryForecastRefresh(forecastByDate.get(dateKey)));

    if (syncBackfillLimit > 0 && missingDateKeys.length > 0) {
      const syncDates = missingDateKeys.slice(-syncBackfillLimit).reverse();

      for (const dateKey of syncDates) {
        const forecast = await ensureHistoryForecast(cafeId, zonedDayStart(dateKey, timezone));
        if (forecast) {
          forecastByDate.set(dateKey, typeof forecast.toObject === 'function' ? forecast.toObject() : forecast);
          generated += 1;
        }
      }

      missingDateKeys = dateKeys.filter((dateKey) => needsHistoryForecastRefresh(forecastByDate.get(dateKey)));
    }

    const rows = [];
    for (const dateKey of dateKeys) {
      const forecast = forecastByDate.get(dateKey);
      if (forecast && !needsHistoryForecastRefresh(forecast)) {
        rows.push(buildHistoryRow(forecast, actualByDate.get(dateKey), timezone));
      }
    }

    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const combinedAccuracy = summarizeHistoryAccuracy(rows);
    const liveAccuracy = summarizeHistoryAccuracy(
      rows.filter((row) => row.origin !== 'backfill')
    );
    const backtestAccuracy = summarizeHistoryAccuracy(
      rows.filter((row) => row.origin === 'backfill')
    );
    const totalRows = rows.length;
    const totalPages = Math.max(Math.ceil(totalRows / limit), 1);
    const currentPage = Math.min(page, totalPages);
    const pagedRows = rows.slice((currentPage - 1) * limit, currentPage * limit);

    if (generated > 0) {
      clearApiCache({ cafeId });
    }

    return res.status(200).json({
      success: true,
      history: pagedRows,
      rows: pagedRows,
      meta: {
        days,
        startDate: zonedDateKey(startDay, timezone),
        endDate: zonedDateKey(endDay, timezone),
        totalTradingDays: dateKeys.length,
        totalRows,
        generated,
        pendingDays: missingDateKeys.length,
        isPartial: missingDateKeys.length > 0,
        backfill: {
          status: missingDateKeys.length === 0 ? 'complete' : 'pending',
          pendingDays: missingDateKeys.length,
          batchSize: HISTORY_BACKFILL_BATCH_SIZE,
          resumable: true,
          nextRequest: missingDateKeys.length > 0 ? 'backfill=sync' : null,
        },
        liveAccuracy,
        backtestAccuracy,
        combinedAccuracy,
        // Preserve the original combined fields for older clients while making
        // their mixed provenance explicit for new clients.
        overallRevenueAccuracy: combinedAccuracy.overallRevenueAccuracy,
        avgDailyRevenueAccuracy: combinedAccuracy.avgDailyRevenueAccuracy,
        avgRevenueAccuracy: combinedAccuracy.avgDailyRevenueAccuracy,
        totalPredictedRevenue: combinedAccuracy.totalPredictedRevenue,
        totalActualRevenue: combinedAccuracy.totalActualRevenue,
        variance: combinedAccuracy.variance,
        variancePct: combinedAccuracy.variancePct,
      },
      pagination: {
        total: totalRows,
        page: currentPage,
        limit,
        pages: totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
};












const getTomorrow = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);
    const tomorrow = addZonedDays(new Date(), 1, timezone);

    let forecast = await Forecast.findOne({ cafeId, date: tomorrow });

    if (needsPlanningRefresh(forecast, timezone)) {
      forecast = await generateForecast(cafeId, tomorrow, { origin: 'live' });
    }

    return res.status(200).json({ success: true, forecast: forecastForApi(forecast, timezone) });
  } catch (error) {
    next(error);
  }
};

const getRecent = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);
    const today = zonedDayStart(new Date(), timezone);
    const sevenDaysAgo = addZonedDays(today, -7, timezone);

    const forecasts = await Forecast.find({
      cafeId,
      date: { $gte: sevenDaysAgo, $lt: today },
      $or: [
        { actualsUpdatedAt: { $exists: true, $ne: null } },
        { actualTransactionCount: { $gt: 0 } },
        { accuracy: { $exists: true, $ne: null } },
      ],
    })
      .sort({ date: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      forecasts: forecasts.map((forecast) => forecastForApi(forecast, timezone)),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getToday,
  getTomorrow,
  getWeek,
  generate,
  getFactors,
  updateFactors,
  getAccuracy,
  getHistory,
  getRecent,
};
