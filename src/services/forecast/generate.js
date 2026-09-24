// Forecast generation for a day and a week: trading availability, signals, grouping, calibration, per-item loop, upsert.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Transaction = require('../../models/Transaction.model');
const Item = require('../../models/Item.model');
const Forecast = require('../../models/Forecast.model');
const Event = require('../../models/Event.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const { getSignalsForDate } = require('../../utils/signals');
const { getWeatherForecast, unavailableWeatherSignal } = require('../weather.service');
const {
  safeTimezone, zonedDayStart, addZonedDays, zonedDayOfWeek, zonedDayOrdinal, processLocalCalendarDate,
  zonedDateKey,
} = require('../../utils/timezone');
const {
  getForecastSettings, getFactorEntitlements, factorUnlocked, buildGlobalFactors, buildItemFactors, multiplyFactors,
} = require('../forecastFactors.service');
const { getCafeTradingHours, parseTime } = require('../../utils/tradingHours');
const {
  clamp, computeForecastCalibration, CALIBRATION_LOOKBACK_DAYS, buildLearningFactor, calibrationMultiplierForItem,
} = require('./calibration');
const {
  groupByWeekAndItem, buildHistoricalPriceMap, weightedAverage, forecastConfidence, requiredHistoryWeeks,
} = require('./history');
const { computeSuggestedStockMap } = require('./stock');

const FORECAST_MODEL_VERSION = '2026-07-30.1';
const MAX_STORED_FORECAST_ITEMS = 25;

/**
 * Resolves whether the cafe trades on the target day and by how much.
 *
 * `source` records where a closure came from -- 'schedule' for the trading
 * hours in Settings, 'event' for a closure or partial-closure event in Factors
 * -- because the remedy the operator is shown has to match the cause.
 */
const getTradingAvailability = (cafe, events, dayOfWeek) => {
  const schedule = getCafeTradingHours(cafe).find((entry) => entry.dayOfWeek === dayOfWeek);
  if (!schedule?.isOpen) {
    return {
      status: 'closed',
      multiplier: 0,
      reason: 'Cafe is closed in its trading hours',
      source: 'schedule',
    };
  }

  const fullClosure = (events || []).find((event) => event.type === 'closure');
  if (fullClosure) {
    return {
      status: 'closed',
      multiplier: 0,
      reason: fullClosure.name || 'Cafe closure',
      source: 'event',
      eventName: fullClosure.name || '',
    };
  }

  const openMinutes = parseTime(schedule.openTime);
  const closeMinutes = parseTime(schedule.closeTime);
  const scheduledMinutes = closeMinutes != null && openMinutes != null ? closeMinutes - openMinutes : 0;
  if (scheduledMinutes <= 0) {
    return {
      status: 'closed',
      multiplier: 0,
      reason: 'Cafe has no valid trading window',
      source: 'schedule',
    };
  }

  const closureIntervals = (events || [])
    .filter((entry) => entry.type === 'partial_closure')
    .map((event) => {
      const start = parseTime(event.closureWindow?.startTime);
      const end = parseTime(event.closureWindow?.endTime);
      if (start == null || end == null || end <= start) return null;
      const clippedStart = Math.max(openMinutes, start);
      const clippedEnd = Math.min(closeMinutes, end);
      return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);

  let closedMinutes = 0;
  let activeInterval = null;
  for (const interval of closureIntervals) {
    if (!activeInterval) {
      activeInterval = interval;
      continue;
    }
    if (interval[0] <= activeInterval[1]) {
      activeInterval[1] = Math.max(activeInterval[1], interval[1]);
      continue;
    }
    closedMinutes += activeInterval[1] - activeInterval[0];
    activeInterval = interval;
  }
  if (activeInterval) closedMinutes += activeInterval[1] - activeInterval[0];

  const multiplier = clamp(1 - Math.min(scheduledMinutes, closedMinutes) / scheduledMinutes, 0, 1);
  if (multiplier < 1) {
    return {
      status: multiplier === 0 ? 'closed' : 'ready',
      multiplier,
      reason: multiplier === 0 ? 'Partial closures cover the full trading day' : 'Reduced trading hours',
      source: 'event',
    };
  }
  return { status: 'ready', multiplier: 1, reason: '' };
};

/**
 * Words the explanation for a day that is forecasting zero, and says whether
 * that zero contradicts the sales record.
 *
 * Configuration is never checked against reality anywhere else, and the two
 * can disagree silently: a weekday marked closed still forecasts zero even
 * when months of sales exist for it. That mis-set Sunday cost ~9 points of
 * aggregate accuracy before anyone noticed, because a zero forecast on a
 * trading day looks like a quiet day rather than a broken setting.
 *
 * The remedy has to match the cause. A closure that comes from the trading
 * hours schedule is fixed in Settings. One that comes from a closure event is
 * deliberate -- the operator recorded it precisely because the cafe normally
 * trades that day -- so it is fixed in Factors and is not a contradiction.
 * Sending an event closure to the trading hours pointed people at the wrong
 * screen.
 */
const describeClosedDay = (trading, { salesCount = 0, observedWeeks = 0, maxWeeks } = {}) => {
  if (trading.source === 'event') {
    const closure = trading.eventName ? `Closed for ${trading.eventName}` : trading.reason;
    return {
      contradictsHistory: false,
      reason: `${closure}. Remove the event in Factors if the cafe is trading.`,
    };
  }
  if (observedWeeks > 0 && salesCount > 0) {
    return {
      contradictsHistory: true,
      reason:
        `${trading.reason}, but ${salesCount} sales were recorded on this weekday in the last ` +
        `${maxWeeks} weeks. Check the trading hours in Settings — this day is forecasting zero.`,
    };
  }
  return { contradictsHistory: false, reason: trading.reason };
};

/**
 * Generates a sales forecast for a cafe on a specific target date.
 *
 * @param {string|ObjectId} cafeId
 * @param {Date|string} targetDate
 * @returns {Promise<Forecast>}
 */
const generateForecast = async (cafeId, targetDate, options = {}) => {
  const cafe = await Cafe.findById(cafeId).lean();
  if (!cafe) {
    const error = new Error('Cafe not found');
    error.statusCode = 404;
    throw error;
  }
  const timezone = safeTimezone(cafe.timezone);
  const target = zonedDayStart(targetDate, timezone);
  if (!target) {
    const error = new Error('Invalid forecast date');
    error.statusCode = 400;
    throw error;
  }
  const nextTarget = addZonedDays(target, 1, timezone);
  const targetDayOfWeek = zonedDayOfWeek(target, timezone);

  // Settings first: the history window depends on them. The plan is resolved
  // here too, because the lookback is a Pro factor and the window has to follow
  // the plan-clamped value, not whatever is stored on the cafe.
  const org = cafe?.orgId ? await Organization.findById(cafe.orgId).lean() : null;
  const plan = org?.plan || 'starter';
  const settings = getForecastSettings(cafe, plan);
  const entitlements = getFactorEntitlements(plan);
  const learningEnabled = factorUnlocked(plan, 'learning') && settings.learning.enabled;

  // Fetch the lookback's worth of same-day-of-week transactions. This was a
  // fixed 56 days while the Factors page let a Pro lookback go to 16 weeks, so
  // week buckets 8-15 could never be populated and a longer lookback was
  // inert; a shorter one merely fetched rows that groupByWeekAndItem then
  // discarded. Bucket k holds days k*7+1 to (k+1)*7 before the target, so a
  // window of exactly maxWeeks*7 days feeds every bucket and nothing else.
  const historyWindowStart = addZonedDays(target, -settings.history.maxWeeks * 7, timezone);

  const transactions = await Transaction.find({
    cafeId,
    dayOfWeek: targetDayOfWeek,
    status: 'approved',
    date: { $gte: historyWindowStart, $lt: target },
  }).lean();

  const historyDates = transactions.map((tx) => new Date(tx.date));
  const firstTransactionDate =
    historyDates.length > 0 ? new Date(Math.min(...historyDates.map((date) => date.getTime()))) : undefined;
  const lastTransactionDate =
    historyDates.length > 0 ? new Date(Math.max(...historyDates.map((date) => date.getTime()))) : undefined;
  const staleDays =
    lastTransactionDate != null
      ? Math.max(0, zonedDayOrdinal(target, timezone) - zonedDayOrdinal(lastTransactionDate, timezone))
      : undefined;

  // Get cafe location for weather
  const lat = cafe.location?.lat;
  const lng = cafe.location?.lng;
  const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const localCalendarDate = processLocalCalendarDate(target, timezone);

  // Fetch signals, weather, and events in parallel
  const [signals, weather, events] = await Promise.all([
    getSignalsForDate(localCalendarDate, { city: cafe.location?.city }),
    hasCoordinates ? getWeatherForecast(lat, lng, localCalendarDate) : Promise.resolve(null),
    Event.find({ cafeId, date: { $gte: target, $lt: nextTarget } }).lean(),
  ]);
  const weatherSignal = weather || unavailableWeatherSignal('Cafe coordinates are not configured');
  const trading = getTradingAvailability(cafe, events, targetDayOfWeek);

  // Group transactions by week and item
  const { itemWeekMap, observedBuckets } = groupByWeekAndItem(
    transactions,
    target,
    timezone,
    settings.history.maxWeeks
  );
  const observedWeeks = observedBuckets.size;
  const missingWeeks = Math.max(0, settings.history.maxWeeks - observedWeeks);
  const historicalPriceMap = buildHistoricalPriceMap(transactions);

  // Forecast every observed item so revenue and accuracy include the long tail.
  // The portal limits visual lists, but the model must not silently omit sales.
  const itemTotals = [];
  for (const [name, buckets] of itemWeekMap.entries()) {
    const total = Object.values(buckets).reduce((s, v) => s + v, 0);
    itemTotals.push({ name, total });
  }
  itemTotals.sort((a, b) => b.total - a.total);
  const forecastItemNames = itemTotals.map((i) => i.name);

  // Fetch item categories
  const itemDocs = await Item.find({ cafeId, name: { $in: forecastItemNames } }).lean();
  const categoryMap = new Map(itemDocs.map((i) => [i.name, i.category]));
  const itemDocMap = new Map(itemDocs.map((item) => [item.name, item]));

  const forecastFactors = buildGlobalFactors({ signals, weather: weatherSignal, events, settings });
  const tradingFactor = {
    key: 'tradingHours',
    label: 'Trading hours',
    active: trading.multiplier !== 1,
    adjustmentPct: Number(((trading.multiplier - 1) * 100).toFixed(2)),
    multiplier: trading.multiplier,
    effect: trading.multiplier === 1
      ? 'no effect'
      : `${Number(((trading.multiplier - 1) * 100).toFixed(1))}%`,
    reason: trading.reason,
  };
  const calibration = learningEnabled
    ? await computeForecastCalibration(cafeId, target, timezone)
    : {
        lookbackDays: CALIBRATION_LOOKBACK_DAYS,
        sampleSize: 0,
        overallMultiplier: 1,
        factorMultipliers: [],
        itemMultipliers: [],
        generatedAt: new Date(),
      };
  const globalLearningFactor = buildLearningFactor(
    calibration.overallMultiplier || 1,
    calibration.sampleSize || 0,
    {
      enabled: learningEnabled,
      reason: 'Learning correction is available on the Pro plan',
    }
  );
  const storedForecastFactors = [...forecastFactors, tradingFactor, globalLearningFactor];
  const forecastItems = [];
  const predictedQtyByItem = new Map();
  let totalPredictedRevenue = 0;
  let totalPredictedQty = 0;

  for (const [itemIndex, name] of forecastItemNames.entries()) {
    const buckets = itemWeekMap.get(name) || Array(settings.history.maxWeeks).fill(null);
    const baseQty = weightedAverage(buckets, settings.history);
    const category = categoryMap.get(name) || 'other';
    const factors = buildItemFactors({ category, signals, weather: weatherSignal, events, settings });
    const learningMultiplier = learningEnabled ? calibrationMultiplierForItem(calibration, name, factors) : 1;
    const learningFactor = buildLearningFactor(
      learningMultiplier,
      calibration.sampleSize || 0,
      {
        enabled: learningEnabled,
        reason: 'Learning correction is available on the Pro plan',
      }
    );
    const storedItemFactors = [...factors, learningFactor];
    const finalQty = Math.max(
      0,
      Math.round(baseQty * multiplyFactors(factors) * learningMultiplier * trading.multiplier)
    );

    // Estimate revenue using item avgPrice if available
    const itemDoc = itemDocMap.get(name);
    const avgPrice = itemDoc?.avgPrice || historicalPriceMap.get(name) || 0;
    totalPredictedRevenue += finalQty * avgPrice;
    totalPredictedQty += finalQty;

    if (itemIndex < MAX_STORED_FORECAST_ITEMS) {
      forecastItems.push({
        itemName: name,
        baseQty: parseFloat(baseQty.toFixed(2)),
        predictedQty: finalQty,
        confidence: forecastConfidence(baseQty, observedWeeks),
        factors: storedItemFactors,
      });
      predictedQtyByItem.set(name, finalQty);
    }
  }

  const suggestedStockByItem = await computeSuggestedStockMap(
    cafeId,
    predictedQtyByItem,
    settings,
    target,
    timezone
  );
  for (const item of forecastItems) {
    item.suggestedStock = suggestedStockByItem.get(item.itemName) ?? item.predictedQty;
  }

  // Upsert forecast document
  const existingForecast = await Forecast.findOne({
    cafeId,
    date: { $gte: target, $lt: nextTarget },
  }).select('_id').lean();
  const dateKey = zonedDateKey(target, timezone);
  const origin = ['live', 'backfill', 'manual'].includes(options.origin)
    ? options.origin
    : 'live';
  const weeksRequired = requiredHistoryWeeks(settings.history.maxWeeks);
  const availabilityStatus = trading.status === 'closed'
    ? 'closed'
    : observedWeeks < weeksRequired
      ? 'insufficient_data'
      : 'ready';
  // `transactions` is already the matching-weekday window, so the
  // contradiction check in describeClosedDay is free.
  const closedDay = availabilityStatus === 'closed'
    ? describeClosedDay(trading, {
        salesCount: transactions.length,
        observedWeeks,
        maxWeeks: settings.history.maxWeeks,
      })
    : { contradictsHistory: false, reason: '' };
  const contradictsHistory = closedDay.contradictsHistory;
  const availabilityReason = availabilityStatus === 'closed'
    ? closedDay.reason
    : availabilityStatus === 'insufficient_data'
      ? `At least ${weeksRequired} observed matching trading days are required; ${observedWeeks} available`
      : '';
  const forecast = await Forecast.findOneAndUpdate(
    existingForecast ? { _id: existingForecast._id } : { cafeId, date: target },
    {
      $set: {
        cafeId,
        date: target,
        dateKey,
        generatedAt: new Date(),
        origin,
        modelVersion: FORECAST_MODEL_VERSION,
        trainingCutoff: target,
        availability: {
          status: availabilityStatus,
          reason: availabilityReason,
          contradictsHistory,
        },
        items: forecastItems,
        signals: {
          weather: {
            available: weatherSignal.available,
            temp: weatherSignal.temp,
            condition: weatherSignal.condition,
            humidity: weatherSignal.humidity,
            isRain: weatherSignal.isRain,
            precipMm: weatherSignal.precipMm,
            chanceOfRain: weatherSignal.chanceOfRain,
            unavailableReason: weatherSignal.unavailableReason,
          },
          loadSheddingStage: signals.loadSheddingStage,
          loadSheddingAvailable: signals.loadSheddingAvailable,
          loadSheddingUnavailableReason: signals.loadSheddingUnavailableReason,
          isPublicHoliday: signals.isPublicHoliday,
          isSchoolHoliday: signals.isSchoolHoliday,
          isPayday: signals.isPayday,
          dayOfWeek: targetDayOfWeek,
          events: events.map((e) => ({
            name: e.name,
            type: e.type,
            impact: e.impact,
            impactPct: e.impactPct,
            closureWindow: e.closureWindow,
          })),
        },
        factors: storedForecastFactors,
        factorSettings: settings,
        factorEntitlements: entitlements,
        calibration,
        totalPredictedRevenue: parseFloat(totalPredictedRevenue.toFixed(2)),
        forecastCoverage: {
          itemCount: forecastItemNames.length,
          storedItemCount: forecastItems.length,
          totalPredictedQty,
          includesAllRevenue: true,
          accuracyMethod: 'aggregate_quantity',
          predictedItemNames: forecastItemNames,
        },
        trainingData: {
          transactionCount: transactions.length,
          firstTransactionDate,
          lastTransactionDate,
          weeksWithSales: observedWeeks,
          observedWeeks,
          missingWeeks,
          staleDays,
        },
      },
      $unset: {
        accuracy: '',
        actualRevenue: '',
        actualTransactionCount: '',
        actualsUpdatedAt: '',
      },
    },
    { upsert: true, new: true }
  );

  return forecast;
};

/**
 * Generates forecasts for the next 7 days.
 * @param {string|ObjectId} cafeId
 * @returns {Promise<Forecast[]>}
 */
const generateWeekForecast = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  if (!cafe) {
    const error = new Error('Cafe not found');
    error.statusCode = 404;
    throw error;
  }
  const timezone = safeTimezone(cafe.timezone);
  const today = zonedDayStart(new Date(), timezone);

  const targetDates = Array.from(
    { length: 7 },
    (_, index) => addZonedDays(today, index, timezone)
  );

  // Resilient: a transient failure on one day must not lose the whole week.
  const results = await Promise.allSettled(
    targetDates.map((targetDate) => generateForecast(cafeId, targetDate, { origin: 'live' }))
  );
  return results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
};

module.exports = {
  FORECAST_MODEL_VERSION, MAX_STORED_FORECAST_ITEMS, getTradingAvailability, describeClosedDay, generateForecast, generateWeekForecast,
};
