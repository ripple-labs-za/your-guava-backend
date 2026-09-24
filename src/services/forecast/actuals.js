// Actuals scoring and the refresh a menu change triggers.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Transaction = require('../../models/Transaction.model');
const Forecast = require('../../models/Forecast.model');
const Cafe = require('../../models/Cafe.model');
const { backgroundJobsInline } = require('../../config/flags');
const { safeTimezone, zonedDayStart, addZonedDays } = require('../../utils/timezone');
const { isDemandLine } = require('../../utils/demand');

/**
 * Pulls actual transactions for a given date and updates forecast accuracy.
 * Accuracy is the bounded relative error between total predicted and sold units.
 *
 * @param {string|ObjectId} cafeId
 * @param {Date|string} date
 * @returns {Promise<Forecast|null>}
 */
const updateForecastActuals = async (cafeId, date, options = {}) => {
  let timezone = options.timezone;
  if (!timezone) {
    const cafe = await Cafe.findById(cafeId).select('timezone').lean();
    timezone = cafe?.timezone;
  }
  timezone = safeTimezone(timezone);
  const target = zonedDayStart(date, timezone);
  if (!target) {
    const error = new Error('Invalid forecast date');
    error.statusCode = 400;
    throw error;
  }
  const nextDay = addZonedDays(target, 1, timezone);

  // A day that has not finished cannot be scored. The upload path fills actuals
  // across the uploaded file's own date range, and a POS export run at midday
  // contains today -- so a partial morning was being compared against a
  // full-day forecast. The resulting near-zero accuracy became both a permanent
  // row in the customer's history and a calibration sample, teaching the model
  // it had over-predicted by an order of magnitude when it had not.
  const todayStart = zonedDayStart(new Date(), timezone);
  if (todayStart && target >= todayStart) {
    return Forecast.findOne({ cafeId, date: { $gte: target, $lt: nextDay } }).sort({ date: 1 });
  }

  const forecast = await Forecast.findOne({
    cafeId,
    date: { $gte: target, $lt: nextDay },
  }).select('+forecastCoverage.predictedItemNames').sort({ date: 1 });
  if (!forecast) return null;

  // Fetch actual transactions for that date
  const transactions = await Transaction.find({
    cafeId,
    status: 'approved',
    date: { $gte: target, $lt: nextDay },
  }).lean();

  if (transactions.length === 0) {
    for (const fi of forecast.items) {
      fi.actualQty = undefined;
    }
    forecast.accuracy = undefined;
    forecast.actualRevenue = undefined;
    forecast.actualTransactionCount = undefined;
    forecast.actualsUpdatedAt = undefined;
    forecast.markModified('items');
    await forecast.save();
    return forecast;
  }

  // Sum actual quantities per item. A forecast made before the owner ignored a line predicted it, and is scored
  // against it; one made after is not (BE-03-T11). The stored items are only the top 25, so the full list recorded at
  // generation decides; forecasts made before it was recorded fall back to their stored items.
  const predictedNames = new Set([
    ...(forecast.forecastCoverage?.predictedItemNames || []),
    ...(forecast.items || []).map((item) => item.itemName),
  ]);
  const actualMap = new Map();
  let actualRevenue = 0;
  for (const tx of transactions) {
    actualRevenue += tx.total || 0;
    for (const item of tx.items || []) {
      if (!isDemandLine(item) && !predictedNames.has(item.name)) continue;
      actualMap.set(item.name, (actualMap.get(item.name) || 0) + item.quantity);
    }
  }

  // Update actualQty on each displayed forecast item. Overall accuracy uses
  // aggregate quantity across every predicted and sold item, including the
  // long tail that is intentionally omitted from the bounded detail payload.
  let totalActual = 0;

  for (const fi of forecast.items) {
    fi.actualQty = actualMap.get(fi.itemName) || 0;
  }

  for (const actualQty of actualMap.values()) totalActual += actualQty;
  const hasCompleteCoverage = forecast.forecastCoverage?.includesAllRevenue === true &&
    Number.isFinite(forecast.forecastCoverage?.totalPredictedQty);
  const totalPredicted = hasCompleteCoverage
    ? forecast.forecastCoverage.totalPredictedQty
    : forecast.items.reduce((sum, item) => sum + (Number(item.predictedQty) || 0), 0);
  const totalAbsError = Math.abs(totalPredicted - totalActual);

  // Aggregate relative accuracy, clamped between 0 and 100.
  const accuracy =
    totalActual > 0
      ? Math.max(0, Math.min(100, (1 - totalAbsError / totalActual) * 100))
      : null;

  forecast.accuracy = accuracy !== null ? parseFloat(accuracy.toFixed(1)) : undefined;
  forecast.actualRevenue = parseFloat(actualRevenue.toFixed(2));
  forecast.actualTransactionCount = transactions.length;
  forecast.actualsUpdatedAt = new Date();
  await forecast.save();

  return forecast;
};

const refreshHistoricalActualsAfterMenuChange = async (cafeId, timezone) => {
  const today = zonedDayStart(new Date(), timezone);
  const historical = await Forecast.find({
    cafeId,
    date: { $lt: today },
    actualsUpdatedAt: { $exists: true, $ne: null },
  })
    .select('date')
    .sort({ date: -1 })
    .limit(366)
    .lean();
  for (const forecast of historical) {
    await updateForecastActuals(cafeId, forecast.date, { timezone });
  }
};

const invalidateFutureForecastsAfterMenuChange = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  if (!cafe) return null;
  const timezone = safeTimezone(cafe.timezone);
  const today = zonedDayStart(new Date(), timezone);
  await Forecast.deleteMany({ cafeId, date: { $gte: today } });
  return timezone;
};

const refreshForecastsAfterMenuChange = async (cafeId) => {
  const timezone = await invalidateFutureForecastsAfterMenuChange(cafeId);
  if (!timezone) return;
  await refreshHistoricalActualsAfterMenuChange(cafeId, timezone);
};

const scheduleForecastRefreshAfterMenuChange = async (cafeId) => {
  // Future plans are invalidated before the mutation response is returned.
  // Historical actual recomputation is bounded and may finish asynchronously.
  const timezone = await invalidateFutureForecastsAfterMenuChange(cafeId);
  if (!timezone) return;
  if (backgroundJobsInline()) {
    await refreshHistoricalActualsAfterMenuChange(cafeId, timezone);
    return;
  }
  setImmediate(() => {
    refreshHistoricalActualsAfterMenuChange(cafeId, timezone).catch((error) => {
      console.error('[forecasts] menu-change refresh failed:', error.message);
    });
  });
};

module.exports = {
  updateForecastActuals, refreshForecastsAfterMenuChange, scheduleForecastRefreshAfterMenuChange,
};
