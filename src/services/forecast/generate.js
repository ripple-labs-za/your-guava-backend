// Forecast generation for a day and a week: trading availability, signals, grouping, calibration, per-item loop, upsert.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Transaction = require('../../models/Transaction.model');
const Item = require('../../models/Item.model');
const Forecast = require('../../models/Forecast.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const { clearApiCache } = require('../../middleware/cache.middleware');
const { getSignalsForDate } = require('../../utils/signals');
const { getWeatherForecast, unavailableWeatherSignal, RAIN_MIN_MM, RAIN_MIN_CHANCE_PCT } = require('../weather.service');
const {
  safeTimezone, zonedDayStart, addZonedDays, zonedDayOfWeek, zonedDayOrdinal, processLocalCalendarDate,
  zonedDateKey,
} = require('../../utils/timezone');
const {
  getForecastSettings, getFactorEntitlements, factorUnlocked, buildGlobalFactors, buildItemFactors, multiplyFactors,
} = require('../forecastFactors.service');
const { resolveDaySchedule, parseTime } = require('../../utils/tradingHours');
const {
  clamp, computeForecastCalibration, CALIBRATION_LOOKBACK_DAYS, buildLearningFactor, calibrationMultiplierForItem,
} = require('./calibration');
const {
  groupByWeekAndItem, buildHistoricalPriceMap, weightedAverage, forecastConfidence, requiredHistoryWeeks,
  bucketDateKeys, loadEventsByDateKey, loadStoredSignalsByDateKey, historicalCalendarSignals,
  deFactorItemBuckets, winsoriseBuckets, buildHourlyProfile,
} = require('./history');
const { computeSuggestedStockMap, loadStockPairs } = require('./stock');

const FORECAST_MODEL_VERSION = '2026-09-29.4';
const MAX_STORED_FORECAST_ITEMS = 25;
const SIGNAL_RETRY_AFTER_MS = 15 * 60 * 1000;

// Bump before deleting so a forecast built from older inputs can never replace a newer version.
const invalidatePlanningForecasts = async (cafeId, { from, timezone, session } = {}) => {
  const cafe = await Cafe.findOneAndUpdate(
    { _id: cafeId }, { $inc: { forecastInputsVersion: 1 } },
    { new: true, projection: { timezone: 1, forecastInputsVersion: 1 }, ...(session ? { session } : {}) }
  ).lean();
  if (!cafe) return { deletedCount: 0, inputsVersion: null };
  const zone = safeTimezone(timezone || cafe.timezone);
  const today = zonedDayStart(new Date(), zone);
  const start = from && new Date(from) > today ? new Date(from) : today;
  let deletion = Forecast.deleteMany({ cafeId, date: { $gte: start } });
  if (session) deletion = deletion.session(session);
  const { deletedCount } = await deletion;
  if (!session) clearApiCache({ cafeId });
  return { deletedCount, inputsVersion: cafe.forecastInputsVersion };
};

const MIN_HOURLY_PROFILE_UNITS = 50;
const overlapMinutes = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

// Share of the scheduled day's units that fall inside the (merged, clipped) closure intervals; null when the profile is too thin.
const hourlyClosedShare = (profile, openMinutes, closeMinutes, intervals) => {
  if (!(profile instanceof Map) || intervals.length === 0) return null;
  let scheduled = 0;
  let closed = 0;
  for (const [hour, units] of profile.entries()) {
    const start = hour * 60;
    const openPart = overlapMinutes(start, start + 60, openMinutes, closeMinutes) / 60;
    if (openPart <= 0) continue;
    scheduled += units * openPart;
    for (const [from, to] of intervals) closed += units * (overlapMinutes(start, start + 60, from, to) / 60);
  }
  if (scheduled < MIN_HOURLY_PROFILE_UNITS) return null;
  return Math.min(1, closed / scheduled);
};

const mergeIntervals = (intervals) => {
  const merged = [];
  for (const interval of [...intervals].sort((left, right) => left[0] - right[0])) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
};

/**
 * Resolves whether the cafe trades on the target day and by how much.
 *
 * `source` records where a closure came from -- 'schedule' for the trading
 * hours in Settings, 'event' for a closure or partial-closure event in Factors
 * -- because the remedy the operator is shown has to match the cause.
 */
const getTradingAvailability = (cafe, events, dayOfWeek, { hasSalesHistory = false, hourlyProfile = null } = {}) => {
  const schedule = resolveDaySchedule(cafe, dayOfWeek, { hasSalesHistory });
  if (!schedule?.isOpen) {
    return {
      status: 'closed', multiplier: 0, reason: 'Cafe is closed in its trading hours', source: 'schedule',
      scheduleSource: schedule?.source || 'default',
    };
  }
  const fullClosure = (events || []).find((event) => event.type === 'closure');
  if (fullClosure) {
    return {
      status: 'closed', multiplier: 0, reason: fullClosure.name || 'Cafe closure', source: 'event',
      eventName: fullClosure.name || '', scheduleSource: schedule.source,
    };
  }
  let openMinutes = parseTime(schedule.openTime);
  let closeMinutes = parseTime(schedule.closeTime);
  // An inferred day has no owner-saved window. Use its observed trading hours
  // when known, including sales before the suggested default opening time.
  if (schedule.source === 'inferred_from_sales' && hourlyProfile instanceof Map) {
    const hours = [...hourlyProfile].filter(([hour, units]) =>
      Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isFinite(units) && units > 0
    ).map(([hour]) => hour);
    if (hours.length > 0) {
      openMinutes = Math.min(...hours) * 60;
      closeMinutes = (Math.max(...hours) + 1) * 60;
    }
  }
  const scheduledMinutes = closeMinutes != null && openMinutes != null ? closeMinutes - openMinutes : 0;
  if (scheduledMinutes <= 0) {
    return {
      status: 'closed', multiplier: 0, reason: 'Cafe has no valid trading window', source: 'schedule',
      scheduleSource: schedule.source,
    };
  }
  const intervals = mergeIntervals((events || [])
    .filter((entry) => entry.type === 'partial_closure')
    .map((event) => {
      const start = parseTime(event.closureWindow?.startTime);
      const end = parseTime(event.closureWindow?.endTime);
      if (start == null || end == null || end <= start) return null;
      const clippedStart = Math.max(openMinutes, start);
      const clippedEnd = Math.min(closeMinutes, end);
      return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
    })
    .filter(Boolean));
  const closedMinutes = intervals.reduce((sum, [from, to]) => sum + (to - from), 0);
  const salesShare = hourlyClosedShare(hourlyProfile, openMinutes, closeMinutes, intervals);
  const closedShare = salesShare != null ? salesShare : Math.min(scheduledMinutes, closedMinutes) / scheduledMinutes;
  const multiplier = Number(clamp(1 - closedShare, 0, 1).toFixed(4));
  const closedShareMethod = salesShare != null ? 'hourly_sales' : 'minutes';
  if (multiplier < 1) {
    return {
      status: multiplier === 0 ? 'closed' : 'ready',
      multiplier,
      reason: multiplier === 0
        ? 'Partial closures cover the full trading day'
        : closedShareMethod === 'hourly_sales'
          ? 'Reduced trading hours, weighted by your hourly sales'
          : 'Reduced trading hours',
      source: 'event',
      scheduleSource: schedule.source,
      closedShareMethod,
    };
  }
  return { status: 'ready', multiplier: 1, reason: '', scheduleSource: schedule.source };
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
// Only what the forecast reads. rawName, prices-at-sale, review status and ids are left in the database.
const TRANSACTION_HISTORY_PROJECTION = 'date dayOfWeek hour hourKnown items.menuItemStatus items.name items.quantity items.unitPrice';

const loadForecastContext = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).lean();
  if (!cafe) {
    const error = new Error('Cafe not found');
    error.statusCode = 404;
    throw error;
  }
  const org = cafe.orgId ? await Organization.findById(cafe.orgId).lean() : null;
  const plan = org?.plan || 'starter';
  const settings = getForecastSettings(cafe, plan);
  return {
    cafe,
    plan,
    settings,
    entitlements: getFactorEntitlements(plan),
    learningEnabled: factorUnlocked(plan, 'learning') && settings.learning.enabled,
    timezone: safeTimezone(cafe.timezone),
    inputsVersion: Number(cafe.forecastInputsVersion) || 0,
  };
};

// Everything a run of target days needs, read once. Calibration and stock are taken as of the first target: later days in a
// planning week add no actuals, so the only difference is up to six older days at the far edge of the 60- and 30-day windows.
const loadForecastInputs = async (cafeId, targets, context, { completedDaysOnly = false } = {}) => {
  const { timezone, settings, learningEnabled } = context;
  const first = targets[0];
  const last = targets[targets.length - 1];
  const afterLast = addZonedDays(last, 1, timezone);
  const maxWeeks = settings.history.maxWeeks;
  const historyCutoff = completedDaysOnly
    ? new Date(Math.min(first.getTime(), zonedDayStart(new Date(), timezone).getTime())) : first;
  const historyStart = addZonedDays(first, -maxWeeks * 7, timezone);
  const historyKeys = [...new Set(targets.flatMap((target) => bucketDateKeys(target, maxWeeks, timezone)))];
  // Only the weekdays being forecast: one for a single day (/today, /generate, each backfill day), all seven for a week. Keeps the
  // single-day paths on the { cafeId, status, dayOfWeek, date } index instead of reading seven times the rows they need.
  const weekdays = [...new Set(targets.map((target) => zonedDayOfWeek(target, timezone)))];
  const [transactions, latestSale, eventsByKey, storedSignalsByKey, calibration, existing] = await Promise.all([
    Transaction.find({ cafeId, status: 'approved', dayOfWeek: { $in: weekdays }, date: { $gte: historyStart, $lt: historyCutoff } })
      .select(TRANSACTION_HISTORY_PROJECTION).lean(),
    Transaction.findOne({ cafeId, status: 'approved', date: { $lt: afterLast } }).sort({ date: -1 }).select('date').lean(),
    loadEventsByDateKey(cafeId, zonedDateKey(historyStart, timezone), zonedDateKey(afterLast, timezone), timezone),
    loadStoredSignalsByDateKey(cafeId, historyKeys),
    learningEnabled ? computeForecastCalibration(cafeId, first, timezone) : Promise.resolve(null),
    Forecast.find({ cafeId, date: { $gte: first, $lt: afterLast } }).select('_id date inputsVersion').lean(),
  ]);
  const names = [...new Set(transactions.flatMap((tx) => (tx.items || []).map((line) => line.name).filter(Boolean)))];
  const [itemDocs, stockPairsByItem] = await Promise.all([
    Item.find({ cafeId, name: { $in: names } }).select('_id name category avgPrice').lean(),
    loadStockPairs(cafeId, first, timezone, names),
  ]);
  return {
    transactions,
    latestSale,
    eventsByKey,
    storedSignalsByKey,
    calibration,
    existingByKey: new Map(existing.map((doc) => [zonedDateKey(doc.date, timezone), doc])),
    itemDocs,
    stockPairsByItem,
  };
};

const buildAndSaveForecast = async (cafeId, target, context, inputs, options = {}) => {
  const { cafe, timezone, inputsVersion, plan, settings, entitlements, learningEnabled } = context;
  const nextTarget = addZonedDays(target, 1, timezone);
  const targetDayOfWeek = zonedDayOfWeek(target, timezone);
  const historyWindowStart = addZonedDays(target, -settings.history.maxWeeks * 7, timezone);

  const transactions = inputs.transactions.filter((tx) => (
    tx.dayOfWeek === targetDayOfWeek && tx.date >= historyWindowStart && tx.date < target
  ));

  const historyDates = transactions.map((tx) => new Date(tx.date));
  const firstTransactionDate =
    historyDates.length > 0 ? new Date(Math.min(...historyDates.map((date) => date.getTime()))) : undefined;
  const lastTransactionDate =
    historyDates.length > 0 ? new Date(Math.max(...historyDates.map((date) => date.getTime()))) : undefined;

  // Get cafe location for weather
  const lat = cafe.location?.lat;
  const lng = cafe.location?.lng;
  const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const localCalendarDate = processLocalCalendarDate(target, timezone);

  // Fetch signals, weather, and events in parallel
  const targetKey = zonedDateKey(target, timezone);
  const historyKeys = bucketDateKeys(target, settings.history.maxWeeks, timezone);
  const { eventsByKey, storedSignalsByKey, latestSale } = inputs;
  const [signals, weather] = await Promise.all([
    getSignalsForDate(localCalendarDate, { city: cafe.location?.city, timezone }),
    hasCoordinates ? getWeatherForecast(lat, lng, localCalendarDate) : Promise.resolve(null),
  ]);
  const events = eventsByKey.get(targetKey) || [];
  const weatherSignal = weather || unavailableWeatherSignal('Cafe coordinates are not configured');
  const transientSignal = weatherSignal.transient === true || signals.loadSheddingTransient === true;
  const retryAfter = transientSignal ? new Date(Date.now() + SIGNAL_RETRY_AFTER_MS) : null;

  // Group transactions by week and item
  const { itemWeekMap, observedBuckets } = groupByWeekAndItem(
    transactions,
    target,
    timezone,
    settings.history.maxWeeks
  );
  const observedWeeks = observedBuckets.size;
  const hourlyProfile = buildHourlyProfile(transactions);
  const trading = getTradingAvailability(cafe, events, targetDayOfWeek, { hasSalesHistory: observedWeeks > 0, hourlyProfile });
  const latestSaleDate = latestSale?.date ? new Date(latestSale.date) : undefined;
  const staleDays = latestSaleDate
    ? Math.max(0, zonedDayOrdinal(target, timezone) - zonedDayOrdinal(latestSaleDate, timezone)) : undefined;
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
  const itemDocs = inputs.itemDocs;
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
  const calibration = inputs.calibration || {
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

  const noStoredWeather = { available: false, condition: 'Unavailable', unavailableReason: 'No weather stored for this day' };
  const pastDayMultiplierCache = new Map();
  const pastDayMultiplier = (category) => (dateKey) => {
    const cacheKey = `${category}|${dateKey}`;
    if (pastDayMultiplierCache.has(cacheKey)) return pastDayMultiplierCache.get(cacheKey);
    const dayEvents = eventsByKey.get(dateKey) || [];
    const stored = storedSignalsByKey.get(dateKey) || {};
    const daySignals = historicalCalendarSignals(dateKey, timezone);
    if (stored.loadSheddingAvailable === true && Number.isFinite(stored.loadSheddingStage)) {
      daySignals.loadSheddingStage = stored.loadSheddingStage;
      daySignals.loadSheddingAvailable = true;
    }
    const dayWeather = stored.weather && stored.weather.available !== false ? {
      ...stored.weather,
      // Reinterpret stored provider measurements under today's rain rule;
      // legacy condition words and their isRain flag are not measurements.
      isRain: Number.isFinite(stored.weather.precipMm)
        ? stored.weather.precipMm >= RAIN_MIN_MM
        : Number.isFinite(stored.weather.chanceOfRain) && stored.weather.chanceOfRain >= RAIN_MIN_CHANCE_PCT,
    } : noStoredWeather;
    // A legacy daily mean cannot establish a daytime high. Ignore only the
    // temperature effects in this historical scoring view, preserving rain.
    const historicalSettings = Number.isFinite(dayWeather.maxTemp) ? settings : {
      ...settings,
      weather: { ...settings.weather, hotColdDrinkPct: 0, hotCoffeePct: 0, coldCoffeePct: 0, coldColdDrinkPct: 0 },
    };
    const factorProduct = multiplyFactors(
      buildItemFactors({ category, signals: daySignals, weather: dayWeather, events: dayEvents, settings: historicalSettings })
    );
    const dayTrading = getTradingAvailability(cafe, dayEvents, targetDayOfWeek, {
      hasSalesHistory: observedWeeks > 0, hourlyProfile,
    });
    // Less than half a normal day is missing history, not a tiny divisor
    // that can turn two observed units into forty estimated units.
    const value = dayTrading.multiplier < 0.5 ? null : factorProduct * dayTrading.multiplier;
    pastDayMultiplierCache.set(cacheKey, value);
    return value;
  };

  for (const [itemIndex, name] of forecastItemNames.entries()) {
    const buckets = itemWeekMap.get(name) || Array(settings.history.maxWeeks).fill(null);
    const category = categoryMap.get(name) || 'other';
    const baselineBuckets = winsoriseBuckets(deFactorItemBuckets(buckets, historyKeys, pastDayMultiplier(category)));
    const baseQty = weightedAverage(baselineBuckets, settings.history);
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
    const appliedLearning = learningFactor.active ? learningFactor.multiplier : 1;
    const expectedQty = Math.max(0, baseQty * multiplyFactors(factors) * appliedLearning * trading.multiplier);
    const storedExpectedQty = Number(expectedQty.toFixed(4));
    // The integer must agree with the expected quantity readers actually receive.
    const finalQty = Math.round(storedExpectedQty);

    // Estimate revenue using item avgPrice if available
    const itemDoc = itemDocMap.get(name);
    const avgPrice = itemDoc?.avgPrice || historicalPriceMap.get(name) || 0;
    totalPredictedRevenue += expectedQty * avgPrice;
    totalPredictedQty += expectedQty;

    if (itemIndex < MAX_STORED_FORECAST_ITEMS) {
      forecastItems.push({
        salesItemId: itemDocMap.get(name)?._id,
        itemName: name,
        baseQty: parseFloat(baseQty.toFixed(2)),
        expectedQty: storedExpectedQty,
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
    timezone,
    { pairsByItem: inputs.stockPairsByItem }
  );
  for (const item of forecastItems) {
    item.suggestedStock = suggestedStockByItem.get(item.itemName) ?? item.predictedQty;
  }

  // Upsert forecast document
  const existingForecast = inputs.existingByKey.get(targetKey);
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
  const update = {
      $set: {
        cafeId,
        date: target,
        dateKey,
        generatedAt: new Date(),
        origin,
        modelVersion: FORECAST_MODEL_VERSION,
        inputsVersion,
        trainingCutoff: target,
        availability: {
          status: availabilityStatus,
          scheduleSource: trading.scheduleSource,
          reason: availabilityReason,
          contradictsHistory,
        },
        items: forecastItems,
        signals: {
          retryAfter,
          weather: {
            available: weatherSignal.available,
            temp: weatherSignal.temp,
            maxTemp: weatherSignal.maxTemp,
            condition: weatherSignal.condition,
            humidity: weatherSignal.humidity,
            isRain: weatherSignal.isRain,
            precipMm: weatherSignal.precipMm,
            chanceOfRain: weatherSignal.chanceOfRain,
            unavailableReason: weatherSignal.unavailableReason,
          },
          loadSheddingStage: signals.loadSheddingStage,
          loadSheddingSource: signals.loadSheddingSource,
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
          totalPredictedQty: Number(totalPredictedQty.toFixed(2)),
          includesAllRevenue: true,
          accuracyMethod: 'aggregate_quantity',
          predictedItemNames: forecastItemNames,
        },
        trainingData: {
          transactionCount: transactions.length,
          firstTransactionDate,
          lastTransactionDate, latestSaleDate,
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
    };
  const versionGuard = { inputsVersion: { $not: { $gt: inputsVersion } } };
  const filter = existingForecast ? { _id: existingForecast._id, ...versionGuard } : { cafeId, date: target, ...versionGuard };
  let forecast;
  try {
    forecast = await Forecast.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    forecast = await Forecast.findOne({ cafeId, date: { $gte: target, $lt: nextTarget } }).sort({ inputsVersion: -1 });
  }
  return forecast;
};

const generateForecast = async (cafeId, targetDate, options = {}) => {
  const context = options.context || await loadForecastContext(cafeId);
  const target = zonedDayStart(targetDate, context.timezone);
  if (!target) {
    const error = new Error('Invalid forecast date');
    error.statusCode = 400;
    throw error;
  }
  const inputs = options.inputs || await loadForecastInputs(cafeId, [target], context);
  return buildAndSaveForecast(cafeId, target, context, inputs, options);
};

const generateForecastsForDates = async (cafeId, dates, { origin = 'live', context: given } = {}) => {
  const context = given || await loadForecastContext(cafeId);
  const targets = dates.map((date) => zonedDayStart(date, context.timezone)).sort((a, b) => a - b);
  if (targets.length === 0) return { forecasts: [], failures: [] };
  const inputs = await loadForecastInputs(cafeId, targets, context, { completedDaysOnly: true });
  // Each day's item loop is synchronous. Yield between days so a shared read does not
  // turn seven short calculations into one long event-loop stall.
  const settled = [];
  for (const target of targets) {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      settled.push({ status: 'fulfilled', value: await buildAndSaveForecast(cafeId, target, context, inputs, { origin }) });
    } catch (reason) {
      settled.push({ status: 'rejected', reason });
    }
  }
  const forecasts = [];
  const failures = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      forecasts.push(result.value);
      return;
    }
    const dateKey = zonedDateKey(targets[index], context.timezone);
    const message = result.reason?.message || 'Forecast generation failed';
    console.error(`[forecasts] week day generation failed for ${dateKey}:`, message);
    failures.push({ dateKey, message });
  });
  return { forecasts, failures };
};

const generateWeekForecast = async (cafeId, { now = new Date() } = {}) => {
  const context = await loadForecastContext(cafeId);
  const today = zonedDayStart(now, context.timezone);
  const targets = Array.from({ length: 7 }, (_, index) => addZonedDays(today, index, context.timezone));
  const { forecasts, failures } = await generateForecastsForDates(cafeId, targets, { origin: 'live', context });
  if (failures.length > 0) {
    const detail = failures.map((failure) => `${failure.dateKey} (${failure.message})`).join('; ');
    const error = new Error(`Forecast generation failed for ${failures.length} of 7 days: ${detail}`.slice(0, 500));
    error.code = 'FORECAST_WEEK_PARTIAL';
    error.failures = failures;
    error.forecasts = forecasts;
    throw error;
  }
  return forecasts;
};

module.exports = {
  TRANSACTION_HISTORY_PROJECTION, loadForecastContext, loadForecastInputs, buildAndSaveForecast, generateForecastsForDates,
  invalidatePlanningForecasts, SIGNAL_RETRY_AFTER_MS,
  FORECAST_MODEL_VERSION, MAX_STORED_FORECAST_ITEMS, MIN_HOURLY_PROFILE_UNITS, hourlyClosedShare, getTradingAvailability, describeClosedDay, generateForecast, generateWeekForecast,
};
