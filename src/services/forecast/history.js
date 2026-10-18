// The history window: required weeks, confidence, weekly grouping, weights, averages and historical prices.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const {
  zonedDayOrdinal, zonedDayStart, addZonedDays, zonedDateKey, processLocalCalendarDate, storedDayKey,
} = require('../../utils/timezone');
const Event = require('../../models/Event.model');
const Forecast = require('../../models/Forecast.model');
const { isPayday, isPublicHoliday, isSchoolHoliday } = require('../../utils/signals');
const { demandLines } = require('../../utils/demand');

// How trustworthy a single item's number is, which is almost entirely a
// function of how many units it moves. Backtested error by tier on real cafe
// data: >=5/day ~25-35%, 2-5/day ~61%, <2/day ~113%. A line selling one unit
// some days and none on others cannot be forecast -- the honest thing is to
// label it rather than print a confident-looking figure next to it.
const MIN_HISTORY_WEEKS = 3;
const CONFIDENCE_HIGH_MIN_QTY = 5;
const CONFIDENCE_MEDIUM_MIN_QTY = 2;

/**
 * Confidence is the lesser of two things: how much of an item sells, and how
 * much evidence stands behind the number.
 *
 * Volume alone is not confidence. A cafe that uploaded a fortnight ago has one
 * matching trading day behind each forecast, and an item selling eight a day
 * would otherwise be labelled "high" off a single observation -- which is the
 * most confident-looking part of the screen on the very day it deserves the
 * least trust. Capping by observed weeks keeps the label honest while the
 * history fills in.
 */
/**
 * How many observed weeks a forecast needs before it is considered usable.
 *
 * Normally three. But the Factors page lets an operator narrow the history
 * lookback to as little as one week, and observed weeks can never exceed the
 * lookback -- so a fixed three made the requirement unsatisfiable and pinned
 * every forecast at insufficient_data, with a message that blamed the data
 * rather than the setting. Asking for two weeks and being told you need three
 * is incoherent; the floor tracks what the operator asked us to look at.
 */
const requiredHistoryWeeks = (maxWeeks) => {
  const weeks = Number(maxWeeks);
  if (!Number.isFinite(weeks) || weeks < 1) return MIN_HISTORY_WEEKS;
  return Math.min(MIN_HISTORY_WEEKS, Math.floor(weeks));
};

const forecastConfidence = (expectedQty, observedWeeks = Infinity) => {
  if (!Number.isFinite(expectedQty)) return 'low';

  const byVolume = expectedQty >= CONFIDENCE_HIGH_MIN_QTY
    ? 'high'
    : expectedQty >= CONFIDENCE_MEDIUM_MIN_QTY
      ? 'medium'
      : 'low';

  const weeks = Number.isFinite(observedWeeks) ? observedWeeks : MIN_HISTORY_WEEKS;
  const byEvidence = weeks >= MIN_HISTORY_WEEKS ? 'high' : weeks >= 2 ? 'medium' : 'low';

  const rank = { low: 0, medium: 1, high: 2 };
  return rank[byVolume] <= rank[byEvidence] ? byVolume : byEvidence;
};

/**
 * Groups transactions by week bucket (most recent = bucket 0) and by item name.
 * Returns: Map<itemName, number[]> where each number is the quantity sold that week.
 */
const groupByWeekAndItem = (transactions, targetDate, timezone, maxWeeks) => {
  const targetOrdinal = zonedDayOrdinal(targetDate, timezone);

  // Bucket index: 0 = this week, 1 = last week, etc.
  const getBucket = (txDate) => {
    const diffDays = targetOrdinal - zonedDayOrdinal(txDate, timezone);
    if (diffDays <= 0) return -1;
    return Math.floor((diffDays - 1) / 7);
  };

  const itemWeekMap = new Map();
  const observedBuckets = new Set();

  for (const tx of transactions) {
    if (!tx.items || tx.items.length === 0) continue;
    const bucket = getBucket(tx.date);
    if (bucket < 0 || bucket >= maxWeeks) continue;
    // The cafe traded that day even if every line was ignored; only demand lines are item history (BE-03-T11).
    observedBuckets.add(bucket);
    for (const item of demandLines(tx.items)) {
      if (!item.name) continue;
      if (!itemWeekMap.has(item.name)) {
        itemWeekMap.set(item.name, Array(maxWeeks).fill(null));
      }
      const buckets = itemWeekMap.get(item.name);
      buckets[bucket] = (buckets[bucket] || 0) + item.quantity;
    }
  }

  // An observed trading day with no sale for an item is a real zero. A bucket
  // with no transactions at all remains null (missing data), not zero.
  for (const buckets of itemWeekMap.values()) {
    for (const bucket of observedBuckets) {
      if (buckets[bucket] == null) buckets[bucket] = 0;
    }
  }

  return { itemWeekMap, observedBuckets };
};

/**
 * Computes weighted moving average for an item's weekly quantity history.
 * Uses the actual populated bucket indices, sorted from most recent (smallest) to oldest,
 * making the algorithm robust to historical data even when recent weeks are empty.
 * @param {{ [bucketIndex: number]: number }} buckets
 * @returns {number}
 */
const buildHistoryWeights = (numWeeks, historySettings) => {
  if (numWeeks === 1) return [1.0];
  if (numWeeks === 2) {
    const weights = historySettings.twoWeekWeights;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map((weight) => weight / total);
  }

  const recentWeights = historySettings.recentWeights.slice(0, 3);
  const remainingWeight = Math.max(0, 1.0 - recentWeights.reduce((sum, weight) => sum + weight, 0));
  const olderWeeks = numWeeks - recentWeights.length;
  const olderWeightPerWeek = olderWeeks > 0 ? remainingWeight / olderWeeks : 0;
  const weights = Array.from({ length: numWeeks }, (_value, index) =>
    index < recentWeights.length ? recentWeights[index] : olderWeightPerWeek
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? weights.map((weight) => weight / total) : Array(numWeeks).fill(1 / numWeeks);
};

const weightedAverage = (buckets, historySettings) => {
  const window = Array.isArray(buckets)
    ? buckets.slice(0, historySettings.maxWeeks)
    : Array.from({ length: historySettings.maxWeeks }, (_, index) => buckets[index] ?? null);
  const weights = buildHistoryWeights(window.length, historySettings);
  let weightedTotal = 0;
  let observedWeight = 0;
  window.forEach((qty, index) => {
    if (qty == null) return;
    weightedTotal += qty * weights[index];
    observedWeight += weights[index];
  });
  if (observedWeight <= 0) return 0;
  // Normalising the weights accumulates floating-point error -- 0.35 + 0.25 +
  // 0.20 is 0.7999... in binary -- which can leave a value a hair below an exact
  // .5 and cost a whole unit at Math.round. Settling it well below any
  // meaningful quantity keeps the displayed base and the prediction agreeing.
  return Number((weightedTotal / observedWeight).toFixed(6));
};

const OUTLIER_WINSOR_MULTIPLE = 1.5;
const OUTLIER_MIN_OBSERVED_WEEKS = 4;
const OUTLIER_MIN_MEDIAN_QTY = 3;

const bucketDateKeys = (target, maxWeeks, timezone) =>
  Array.from({ length: maxWeeks }, (_, bucket) =>
    zonedDateKey(addZonedDays(target, -7 * (bucket + 1), timezone), timezone));

const eventDateKey = (event, timezone) => event?.dateKey || storedDayKey(event?.date, timezone);

const isCalendarDateKey = (key) => {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

// Keep legacy instants readable until migration; dated records use their calendar key.
const loadEventsByDateKey = async (cafeId, fromKey, toKeyExclusive, timezone) => {
  const starts = [new Date(`${fromKey}T00:00:00.000Z`), zonedDayStart(fromKey, timezone)];
  const ends = [new Date(`${toKeyExclusive}T00:00:00.000Z`), zonedDayStart(toKeyExclusive, timezone)];
  const [events, recurring] = await Promise.all([
    Event.find({ cafeId, $or: [
      { dateKey: { $gte: fromKey, $lt: toKeyExclusive } },
      { dateKey: { $exists: false }, date: { $gte: new Date(Math.min(...starts)), $lt: new Date(Math.max(...ends)) } },
    ] }).lean(),
    Event.find({ cafeId, recurring: true, dateKey: { $lt: fromKey } }).lean(),
  ]);
  const byKey = new Map();
  const add = (key, event) => {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(event);
  };
  for (const event of events) {
    const key = eventDateKey(event, timezone);
    if (!key || key < fromKey || key >= toKeyExclusive) continue;
    add(key, event);
  }
  // D-017: anniversaries after the original date, with February 29 only in leap years.
  for (const event of recurring) {
    if (event.recurring !== true || typeof event.dateKey !== 'string' || event.dateKey >= fromKey) continue;
    for (let year = Number(fromKey.slice(0, 4)); year <= Number(toKeyExclusive.slice(0, 4)); year += 1) {
      const key = `${year}-${event.dateKey.slice(5)}`;
      if (key > event.dateKey && key >= fromKey && key < toKeyExclusive && isCalendarDateKey(key)) {
        add(key, { ...event, recurrenceOf: event.dateKey });
      }
    }
  }
  return byKey;
};

const loadStoredSignalsByDateKey = async (cafeId, dateKeys) => {
  if (dateKeys.length === 0) return new Map();
  const docs = await Forecast.find({ cafeId, dateKey: { $in: dateKeys } })
    .select('dateKey signals.weather signals.loadSheddingStage signals.loadSheddingAvailable')
    .lean();
  return new Map(docs.map((doc) => [doc.dateKey, doc.signals || {}]));
};

const historicalCalendarSignals = (dateKey, timezone) => {
  const local = processLocalCalendarDate(dateKey, timezone);
  return {
    isPublicHoliday: isPublicHoliday(local),
    isSchoolHoliday: isSchoolHoliday(local),
    isPayday: isPayday(local),
    loadSheddingStage: null,
    loadSheddingAvailable: false,
  };
};

const deFactorItemBuckets = (buckets, keys, dayMultiplier) =>
  buckets.map((qty, bucket) => {
    if (qty == null) return null;
    const multiplier = dayMultiplier(keys[bucket]);
    // A mostly-closed observed day cannot establish normal demand.
    if (multiplier === null) return null;
    return Number.isFinite(multiplier) && multiplier > 0 ? qty / multiplier : qty;
  });

const winsoriseBuckets = (buckets) => {
  const observed = buckets.filter((qty) => qty != null);
  if (observed.length < OUTLIER_MIN_OBSERVED_WEEKS) return buckets;
  const sorted = [...observed].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  if (!(median >= OUTLIER_MIN_MEDIAN_QTY)) return buckets;
  const cap = median * OUTLIER_WINSOR_MULTIPLE;
  let observedIndex = 0;
  return buckets.map((qty) => {
    if (qty == null) return null;
    const index = observedIndex++;
    // Consecutive high observations are a change in level, even across a
    // missing week. Only an isolated spike should be capped.
    const isolated = !(observed[index - 1] > cap) && !(observed[index + 1] > cap);
    return qty > cap && isolated ? cap : qty;
  });
};

const buildHistoricalPriceMap = (transactions) => {
  const buckets = new Map();

  for (const tx of transactions) {
    for (const item of demandLines(tx.items)) {
      if (!item.name || !Number.isFinite(item.unitPrice) || item.unitPrice <= 0) continue;
      const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      if (!buckets.has(item.name)) {
        buckets.set(item.name, { value: 0, qty: 0 });
      }
      const bucket = buckets.get(item.name);
      bucket.value += item.unitPrice * qty;
      bucket.qty += qty;
    }
  }

  return new Map(
    [...buckets.entries()]
      .filter(([, bucket]) => bucket.qty > 0)
      .map(([name, bucket]) => [name, bucket.value / bucket.qty])
  );
};

// Units sold per local hour across the weekday history. Rows imported without a time are left out (BE-03-T06 marks them hourKnown: false).
const buildHourlyProfile = (transactions) => {
  const profile = new Map();
  for (const tx of transactions || []) {
    if (tx.hourKnown === false || !Number.isInteger(tx.hour) || tx.hour < 0 || tx.hour > 23) continue;
    const units = demandLines(tx.items).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    if (units > 0) profile.set(tx.hour, (profile.get(tx.hour) || 0) + units);
  }
  return profile;
};

module.exports = {
  buildHourlyProfile,
  OUTLIER_WINSOR_MULTIPLE, OUTLIER_MIN_OBSERVED_WEEKS, OUTLIER_MIN_MEDIAN_QTY,
  bucketDateKeys, eventDateKey, isCalendarDateKey, loadEventsByDateKey, loadStoredSignalsByDateKey, historicalCalendarSignals,
  deFactorItemBuckets, winsoriseBuckets,
  MIN_HISTORY_WEEKS, requiredHistoryWeeks, forecastConfidence, groupByWeekAndItem, buildHistoryWeights, weightedAverage,
  buildHistoricalPriceMap,
};
