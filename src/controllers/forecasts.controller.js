const mongoose = require('mongoose');
const Forecast = require('../models/Forecast.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const Transaction = require('../models/Transaction.model');
const {
  FORECAST_MODEL_VERSION,
  generateForecast,
  generateForecastsForDates,
  invalidatePlanningForecasts,
  updateForecastActuals,
  BACKTEST_BASIS_NOTE,
} = require('../services/forecast.service');
const { meterGuavaCredits, historyBackfillCreditsPerDay } = require('../services/usage.service');
const { clearApiCache } = require('../middleware/cache.middleware');
const {
  DEFAULT_FORECAST_SETTINGS,
  validateForecastSettingsInput,
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
// D-005: serialize charged builds of a cafe/day on this single instance. Re-check
// inside the queue so a second user never reserves credits for a day already built.
const historyBackfills = new Map();
const serializeHistoryBackfill = async (key, run) => {
  const previous = historyBackfills.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  historyBackfills.set(key, current);
  try {
    return await current;
  } finally {
    if (historyBackfills.get(key) === current) historyBackfills.delete(key);
  }
};
const HISTORY_MAX_RANGE_DAYS = 366;
// What buildHistoryRow and needsHistoryForecastRefresh read, and nothing else. Item detail is reduced to each item's factor keys.
const HISTORY_ROW_PROJECTION = [
  'date dateKey origin modelVersion trainingCutoff availability totalPredictedRevenue actualRevenue actualTransactionCount',
  'actualsUpdatedAt accuracy itemAccuracy signals factors calibration trainingData generatedAt factorSettings factorEntitlements',
  'items.factors.key',
].join(' ');

// Live scored days needed before the headline accuracy stops leaning on
// backtests. Five is a working week: enough that one bad Saturday cannot move
// the figure twenty points. See DECISIONS D-004.
const LIVE_ACCURACY_MIN_DAYS = 5;
const GENERATE_HORIZON_DAYS = 13;
const getCafeForecastState = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone forecastInputsVersion').lean();
  return { timezone: safeTimezone(cafe?.timezone), inputsVersion: Number(cafe?.forecastInputsVersion) || 0 };
};

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

const needsPlanningRefresh = (forecast, timezone, { inputsVersion = 0, now = new Date() } = {}) => {
  if (!forecast) return true;
  if (hasMatchedActuals(forecast)) return true;
  if (forecast.modelVersion !== FORECAST_MODEL_VERSION) return true;
  if ((Number(forecast.inputsVersion) || 0) < inputsVersion) return true;
  if (forecast.signals?.retryAfter && new Date(forecast.signals.retryAfter) <= now) return true;
  const generatedDateKey = forecast.generatedAt
    ? zonedDateKey(forecast.generatedAt, timezone)
    : null;
  if (generatedDateKey !== zonedDateKey(now, timezone)) return true;
  return !hasPlanningFactorPayload(forecast);
};

// The schema retains this explicit provider-failure reason, whereas the
// weather service's transient flag is not persisted. Unconfigured weather
// has a different reason and remains a usable, honestly labelled backfill.
const historyWeatherIsPending = (forecast) => forecast?.signals?.weather?.available === false
  && forecast.signals.weather.unavailableReason === 'Weather data is temporarily unavailable';

const needsHistoryForecastRefresh = (forecast) => {
  if (!forecast) return true;
  // Never rewrite an original live/manual historical snapshot. Backfills are
  // explicitly marked and may be refreshed without corrupting live audit data.
  if ((forecast.origin || 'live') !== 'backfill') return false;
  if (historyWeatherIsPending(forecast)) return true;
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

const summarizeHistoryAccuracy = (rows, { note = null } = {}) => {
  const counted = rows.filter((row) => row.countsTowardAccuracy !== false);
  const accuracyRows = counted.filter((row) => row.revenueAccuracy != null);
  const itemRows = counted.filter((row) => Number.isFinite(row.itemAccuracy));
  const totalPredictedRevenue = counted.reduce((sum, row) => sum + row.predictedRevenue, 0);
  const totalActualRevenue = counted.reduce((sum, row) => sum + row.actualRevenue, 0);
  const variance = totalActualRevenue - totalPredictedRevenue;

  return {
    rowCount: counted.length,
    excludedRowCount: rows.length - counted.length,
    overallRevenueAccuracy: revenueAccuracy(totalPredictedRevenue, totalActualRevenue),
    avgDailyRevenueAccuracy: accuracyRows.length > 0
      ? parseFloat((accuracyRows.reduce((sum, row) => sum + row.revenueAccuracy, 0) / accuracyRows.length).toFixed(1))
      : null,
    avgItemAccuracy: itemRows.length > 0
      ? parseFloat((itemRows.reduce((sum, row) => sum + row.itemAccuracy, 0) / itemRows.length).toFixed(1))
      : null,
    totalPredictedRevenue: parseFloat(totalPredictedRevenue.toFixed(2)),
    totalActualRevenue: parseFloat(totalActualRevenue.toFixed(2)),
    variance: parseFloat(variance.toFixed(2)),
    variancePct: totalPredictedRevenue > 0
      ? parseFloat(((variance / totalPredictedRevenue) * 100).toFixed(1))
      : null,
    note: counted.length > 0 ? note : null,
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
    availabilityStatus: forecast.availability?.status || 'ready',
    countsTowardAccuracy: (forecast.availability?.status || 'ready') !== 'insufficient_data',
    volumeAccuracy: forecast.accuracy ?? null,
    itemAccuracy: forecast.itemAccuracy ?? null,
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
    const { timezone, inputsVersion } = await getCafeForecastState(cafeId);
    const today = zonedDayStart(new Date(), timezone);

    let forecast = await Forecast.findOne({ cafeId, date: today });

    if (needsPlanningRefresh(forecast, timezone, { inputsVersion })) {
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
    const { timezone, inputsVersion } = await getCafeForecastState(cafeId);
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
    const stale = targetDates.filter((date) => needsPlanningRefresh(
      existingByDate.get(zonedDateKey(date, timezone)), timezone, { inputsVersion }
    ));
    const { forecasts: rebuilt, failures } = stale.length > 0
      ? await generateForecastsForDates(cafeId, stale, { origin: 'live' })
      : { forecasts: [], failures: [] };
    const staleKeys = new Set(stale.map((date) => zonedDateKey(date, timezone)));
    const byDate = new Map(existing.filter((forecast) => !staleKeys.has(zonedDateKey(forecast.date, timezone)))
      .map((forecast) => [zonedDateKey(forecast.date, timezone), forecast]));
    for (const forecast of rebuilt) if (forecast) byDate.set(zonedDateKey(forecast.date, timezone), forecast);
    const forecasts = targetDates.map((date) => byDate.get(zonedDateKey(date, timezone)))
      .filter(Boolean).map((forecast) => forecastForApi(forecast, timezone));
    const insufficientDays = forecasts
      .filter((forecast) => forecast.availability?.status === 'insufficient_data')
      .map((forecast) => forecast.dateKey);

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
    const today = zonedDayStart(new Date(), timezone);
    const lastDay = addZonedDays(today, GENERATE_HORIZON_DAYS, timezone);
    if (targetDate < today || targetDate > lastDay) {
      const allowedFrom = zonedDateKey(today, timezone);
      const allowedTo = zonedDateKey(lastDay, timezone);
      return res.status(400).json({
        success: false, code: 'FORECAST_DATE_OUT_OF_RANGE',
        message: `date must be between ${allowedFrom} and ${allowedTo} in the cafe's calendar`,
        allowedFrom, allowedTo,
      });
    }
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
    const input = Object.prototype.hasOwnProperty.call(req.body || {}, 'settings') ? req.body.settings : req.body;
    const invalid = validateForecastSettingsInput(input);
    if (invalid) return res.status(400).json({ success: false, code: 'INVALID_FORECAST_SETTINGS', message: invalid });
    const org = await Organization.findById(req.user.orgId).lean();
    const plan = org?.plan || 'starter';

    const { settings: savedSettings, lockedChange } = applyForecastSettingsUpdate(
      cafe,
      input,
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

    await invalidatePlanningForecasts(cafe._id, { timezone: cafe.timezone });

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

    const window = {
      cafeId,
      date: { $gte: thirtyDaysAgo, $lt: today },
      accuracy: { $exists: true, $ne: null },
      actualsUpdatedAt: { $exists: true, $ne: null },
    };
    const [scored, excludedInsufficientDays] = await Promise.all([
      Forecast.find({ ...window, 'availability.status': { $ne: 'insufficient_data' } })
        .sort({ date: -1 })
        .select('date dateKey origin modelVersion accuracy itemAccuracy totalPredictedRevenue actualRevenue actualTransactionCount actualsUpdatedAt')
        .lean(),
      Forecast.countDocuments({ ...window, 'availability.status': 'insufficient_data' }),
    ]);

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
    const itemScored = chosen.filter((forecast) => Number.isFinite(forecast.itemAccuracy));
    const avgItemAccuracy = itemScored.length > 0
      ? parseFloat((itemScored.reduce((sum, forecast) => sum + forecast.itemAccuracy, 0) / itemScored.length).toFixed(1))
      : null;

    return res.status(200).json({
      success: true,
      avgAccuracy: avgAccuracy !== null ? parseFloat(avgAccuracy.toFixed(1)) : null,
      avgItemAccuracy,
      itemAccuracyDays: itemScored.length,
      excludedInsufficientDays,
      basisNote: basis === 'backtest' ? BACKTEST_BASIS_NOTE : null,
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
    const earliestStart = addZonedDays(endDay, -(HISTORY_MAX_RANGE_DAYS - 1), timezone);
    const requestedStart = parseRequestedDay(req.query.startDate, timezone);
    const rangeClamped = Boolean(requestedStart && requestedStart < earliestStart);
    const startDay = requestedStart ? (rangeClamped ? earliestStart : requestedStart) : addZonedDays(endDay, -(days - 1), timezone);
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
      .select(HISTORY_ROW_PROJECTION)
      .lean();

    const forecastByDate = new Map(
      forecasts.map((forecast) => [zonedDateKey(forecast.date, timezone), forecast])
    );
    let generated = 0;
    const creditsPerDay = historyBackfillCreditsPerDay();
    let creditsUsed = 0;
    let missingDateKeys = dateKeys.filter((dateKey) => needsHistoryForecastRefresh(forecastByDate.get(dateKey)));

    if (syncBackfillLimit > 0 && missingDateKeys.length > 0) {
      const syncDates = missingDateKeys.slice(-syncBackfillLimit).reverse();

      for (const dateKey of syncDates) {
        await serializeHistoryBackfill(`${cafeId}:${dateKey}`, async () => {
          const current = await Forecast.findOne({ cafeId, date: zonedDayStart(dateKey, timezone) }).lean();
          if (current && !needsHistoryForecastRefresh(current)) {
            forecastByDate.set(dateKey, current);
            return;
          }
          let built = null;
          const attempt = current?.generatedAt ? new Date(current.generatedAt).getTime() : 'missing';
          const { result, replayed } = await meterGuavaCredits({
            orgId: req.user.orgId,
            cafeId,
            userId: req.user.id,
            featureKey: 'history_backfill_day',
            credits: creditsPerDay,
            relatedEntity: { kind: 'forecast_day', id: dateKey },
            idempotencyKey: `hbd:${cafeId}:${dateKey}:${req.user.id}:${attempt}:${creditsPerDay}`,
            run: async () => {
              built = await ensureHistoryForecast(cafeId, zonedDayStart(dateKey, timezone));
              if (historyWeatherIsPending(built)) {
                const error = new Error('Historical weather is temporarily unavailable; this day remains pending');
                error.code = 'HISTORY_WEATHER_PENDING';
                throw error; // The meter refunds before the day can be counted as built.
              }
              return { forecastId: built ? String(built._id) : null, dateKey };
            },
          }).catch((error) => {
            if (error.code !== 'HISTORY_WEATHER_PENDING'
              || (creditsPerDay > 0 && error.guavaCharge?.status !== 'refunded')) throw error;
            clearApiCache({ cafeId });
            return { result: null, replayed: false };
          });
          const forecast = built || (result?.forecastId ? await Forecast.findOne({ _id: result.forecastId, cafeId }).lean() : null);
          if (forecast && !needsHistoryForecastRefresh(forecast)) {
            forecastByDate.set(dateKey, typeof forecast.toObject === 'function' ? forecast.toObject() : forecast);
            generated += 1;
            if (!replayed) creditsUsed += creditsPerDay;
            // A later day can exhaust credits or fail. Publish each saved day's
            // history immediately even when the overall batch returns an error.
            clearApiCache({ cafeId });
          }
        });
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
      rows.filter((row) => row.origin === 'backfill'), { note: BACKTEST_BASIS_NOTE }
    );
    const totalRows = rows.length;
    const totalPages = Math.max(Math.ceil(totalRows / limit), 1);
    const currentPage = Math.min(page, totalPages);
    const pagedRows = rows.slice((currentPage - 1) * limit, currentPage * limit);

    return res.status(200).json({
      success: true,
      history: pagedRows,
      rows: pagedRows,
      meta: {
        days,
        rangeClamped,
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
          creditsPerDay,
          creditsUsed,
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
    const { timezone, inputsVersion } = await getCafeForecastState(cafeId);
    const tomorrow = addZonedDays(new Date(), 1, timezone);

    let forecast = await Forecast.findOne({ cafeId, date: tomorrow });

    if (needsPlanningRefresh(forecast, timezone, { inputsVersion })) {
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
  _test: { HISTORY_ROW_PROJECTION, HISTORY_MAX_RANGE_DAYS, needsPlanningRefresh, GENERATE_HORIZON_DAYS },
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
