// Actuals scoring and the refresh a menu change triggers.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Transaction = require('../../models/Transaction.model');
const Forecast = require('../../models/Forecast.model');
const Cafe = require('../../models/Cafe.model');
const Item = require('../../models/Item.model');
const { invalidatePlanningForecasts } = require('./generate');
const { backgroundJobsInline } = require('../../config/flags');
const { safeTimezone, zonedDayStart, addZonedDays } = require('../../utils/timezone');
const { isDemandLine } = require('../../utils/demand');

const BACKTEST_BASIS_NOTE =
  "Backtests are scored with the weather that actually happened and today's menu prices, so they read better than live forecasts will.";

const storedPrediction = (item) => (Number.isFinite(item.expectedQty) ? item.expectedQty : Number(item.predictedQty) || 0);
const MAX_MERGE_HOPS = 5;
const loadItemIndex = async (cafeId, ids) => {
  const index = new Map();
  let pending = [...new Set(ids.filter(Boolean).map(String))];
  for (let hop = 0; hop <= MAX_MERGE_HOPS && pending.length > 0; hop += 1) {
    const docs = await Item.find({ cafeId, _id: { $in: pending } }).select('_id name mergedInto').lean();
    for (const doc of docs) index.set(String(doc._id), { name: doc.name, mergedInto: doc.mergedInto ? String(doc.mergedInto) : null });
    pending = docs.map((doc) => doc.mergedInto && String(doc.mergedInto)).filter((id) => id && !index.has(id));
  }
  return index;
};
const canonicalItemId = (index, id) => {
  let current = id ? String(id) : null;
  for (let hop = 0; current && hop < MAX_MERGE_HOPS; hop += 1) {
    const next = index.get(current)?.mergedInto;
    if (!next) break;
    current = next;
  }
  return current;
};

const menuRefreshes = new Map();
const runCoalescedMenuRefresh = (cafeId, run) => {
  const key = String(cafeId);
  const running = menuRefreshes.get(key);
  if (running) {
    running.rerun = true;
    return running.promise;
  }
  const entry = { rerun: false, promise: null };
  menuRefreshes.set(key, entry);
  entry.promise = (async () => {
    try {
      do {
        entry.rerun = false;
        await run();
      } while (entry.rerun);
    } finally { menuRefreshes.delete(key); }
  })();
  return entry.promise;
};
const waitForMenuRefresh = (cafeId) => menuRefreshes.get(String(cafeId))?.promise || Promise.resolve();

// Item-level WAPE, with the unstored long tail counted as one aggregate term.
const itemWape = (items, { totalPredicted, totalActual }) => {
  if (!(totalActual > 0)) return null;
  let absError = 0;
  let storedPredicted = 0;
  let storedActual = 0;
  for (const item of items || []) {
    if (item.actualQty == null) continue;
    const predicted = storedPrediction(item);
    absError += Math.abs(predicted - item.actualQty);
    storedPredicted += predicted;
    storedActual += item.actualQty;
  }
  const tailPredicted = Math.max(0, totalPredicted - storedPredicted);
  const tailActual = Math.max(0, totalActual - storedActual);
  absError += Math.abs(tailPredicted - tailActual);
  return Math.max(0, Math.min(100, (1 - absError / totalActual) * 100));
};

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
    forecast.itemAccuracy = undefined;
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
  const lineIds = transactions.flatMap((tx) => (tx.items || []).map((line) => line.salesItemId)).filter(Boolean);
  const itemIndex = options.itemIndex || await loadItemIndex(cafeId, [...forecast.items.map((fi) => fi.salesItemId), ...lineIds]);
  const predictedIds = new Set(forecast.items.map((fi) => canonicalItemId(itemIndex, fi.salesItemId)).filter(Boolean));
  const actualMap = new Map();
  const actualById = new Map();
  let actualRevenue = 0;
  for (const tx of transactions) {
    actualRevenue += tx.total || 0;
    for (const item of tx.items || []) {
      const key = canonicalItemId(itemIndex, item.salesItemId);
      if (!isDemandLine(item) && !predictedNames.has(item.name) && !predictedIds.has(key)) continue;
      actualMap.set(item.name, (actualMap.get(item.name) || 0) + item.quantity);
      if (key) actualById.set(key, (actualById.get(key) || 0) + item.quantity);
    }
  }

  // Update actualQty on each displayed forecast item. Overall accuracy uses
  // aggregate quantity across every predicted and sold item, including the
  // long tail that is intentionally omitted from the bounded detail payload.
  let totalActual = 0;

  const owners = new Map();
  const canonicalPredictions = new Map();
  for (const fi of forecast.items) {
    const key = canonicalItemId(itemIndex, fi.salesItemId);
    if (key) canonicalPredictions.set(key, (canonicalPredictions.get(key) || 0) + storedPrediction(fi));
    if (key && (!owners.has(key) || String(fi.salesItemId) === key)) owners.set(key, fi);
  }
  let mergedLine = false;
  for (const fi of forecast.items) {
    const key = canonicalItemId(itemIndex, fi.salesItemId);
    if (!key) {
      fi.actualQty = actualMap.get(fi.itemName) || 0;
      continue;
    }
    if (owners.get(key) !== fi) {
      fi.actualQty = null;
      mergedLine = true;
      continue;
    }
    fi.actualQty = actualById.has(key) ? actualById.get(key) : (actualMap.get(fi.itemName) || 0);
    const name = itemIndex.get(key)?.name;
    if (name) fi.itemName = name;
  }
  forecast.calibrationExcluded = mergedLine ? true : undefined;
  forecast.markModified('items');

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
  // A merge combines demand, so compare the owner's actual against every
  // prediction for its canonical item without changing the stored forecasts.
  const scoringItems = forecast.items.filter((fi) => fi.actualQty != null).map((fi) => ({
    expectedQty: canonicalPredictions.get(canonicalItemId(itemIndex, fi.salesItemId)) ?? storedPrediction(fi),
    actualQty: fi.actualQty,
  }));
  const itemAccuracy = itemWape(scoringItems, { totalPredicted, totalActual });
  forecast.itemAccuracy = itemAccuracy !== null ? parseFloat(itemAccuracy.toFixed(1)) : undefined;
  forecast.actualRevenue = parseFloat(actualRevenue.toFixed(2));
  forecast.actualTransactionCount = transactions.length;
  forecast.actualsUpdatedAt = new Date();
  await forecast.save();

  return forecast;
};

const refreshHistoricalActualsAfterMenuChange = async (cafeId, timezone) => {
  const itemIndex = await loadItemIndex(cafeId, (await Item.find({ cafeId }).select('_id').lean()).map((doc) => doc._id));
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
    await updateForecastActuals(cafeId, forecast.date, { timezone, itemIndex });
  }
};

const invalidateFutureForecastsAfterMenuChange = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  if (!cafe) return null;
  const timezone = safeTimezone(cafe.timezone);
  await invalidatePlanningForecasts(cafeId, { timezone });
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
  const refresh = runCoalescedMenuRefresh(cafeId, () => refreshHistoricalActualsAfterMenuChange(cafeId, timezone));
  if (backgroundJobsInline()) await refresh;
  else refresh.catch((error) => {
      console.error('[forecasts] menu-change refresh failed:', error.message);
  });
};

module.exports = {
  runCoalescedMenuRefresh, waitForMenuRefresh,
  BACKTEST_BASIS_NOTE, itemWape,
  updateForecastActuals, refreshForecastsAfterMenuChange, scheduleForecastRefreshAfterMenuChange,
};
