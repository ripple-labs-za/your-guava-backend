// Suggested stock from predicted quantities (computeSuggestedStock is dead code BE-11-T06 deletes).
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Forecast = require('../../models/Forecast.model');
const { zonedDayStart, addZonedDays } = require('../../utils/timezone');

/**
 * Computes a suggested stock quantity for a given item based on historical forecast bias.
 * Uses the 30 days before the target date where actualQty was recorded.
 *
 * @param {string|ObjectId} cafeId
 * @param {string} itemName
 * @param {number} predictedQty
 * @returns {Promise<number>}
 */
const computeSuggestedStock = async (
  cafeId,
  itemName,
  predictedQty,
  settings,
  targetDate = new Date(),
  timezone = 'Africa/Johannesburg'
) => {
  const target = zonedDayStart(targetDate, timezone);
  const thirtyDaysAgo = addZonedDays(target, -30, timezone);

  const pastForecasts = await Forecast.find({
    calibrationExcluded: { $ne: true },
    cafeId,
    date: { $gte: thirtyDaysAgo, $lt: target },
    'items.itemName': itemName,
    'items.actualQty': { $gt: 0 },
  })
    .select('items')
    .lean();

  // Extract matched item pairs (predicted vs actual)
  const pairs = [];
  for (const doc of pastForecasts) {
    for (const item of doc.items || []) {
      if (item.itemName === itemName && item.actualQty > 0 && item.predictedQty != null) {
        pairs.push({ predicted: item.predictedQty, actual: item.actualQty });
      }
    }
  }

  return computeSuggestedStockFromPairs(predictedQty, pairs, settings);
};

const computeSuggestedStockFromPairs = (predictedQty, pairs, settings) => {
  const safetyMargin = 1 + settings.stock.safetyMarginPct / 100;
  const maxBias = settings.stock.maxBiasPct / 100;

  if (pairs.length >= 3) {
    const avgBias = pairs.reduce((sum, p) => {
      const bias = (p.actual - p.predicted) / Math.max(p.predicted, 1);
      return sum + Math.max(-maxBias, Math.min(maxBias, bias));
    }, 0) / pairs.length;

    const biasAdjusted = Math.round(predictedQty * (1 + avgBias) * safetyMargin);
    return Math.max(predictedQty, biasAdjusted);
  }

  // Cold start: just apply the safety margin
  return Math.round(predictedQty * safetyMargin);
};

const computeSuggestedStockMap = async (
  cafeId,
  predictedQtyByItem,
  settings,
  targetDate = new Date(),
  timezone = 'Africa/Johannesburg'
) => {
  const itemNames = [...predictedQtyByItem.keys()];
  if (itemNames.length === 0) return new Map();

  const target = zonedDayStart(targetDate, timezone);
  const thirtyDaysAgo = addZonedDays(target, -30, timezone);

  // Days the item sold nothing are evidence too -- arguably the most important
  // evidence for a stock buffer. Selecting only actualQty > 0 dropped every
  // negative observation, so the measured bias could only ever point upward and
  // the buffer could only ever over-order. A scored day where an item sold none
  // stores actualQty 0; a day with no trading at all leaves it unset, so those
  // are still excluded.
  const pastForecasts = await Forecast.find({
    calibrationExcluded: { $ne: true },
    cafeId,
    date: { $gte: thirtyDaysAgo, $lt: target },
    'items.itemName': { $in: itemNames },
    'items.actualQty': { $exists: true, $ne: null },
  })
    .select('items')
    .lean();

  const itemNameSet = new Set(itemNames);
  const pairsByItem = new Map(itemNames.map((name) => [name, []]));
  for (const doc of pastForecasts) {
    for (const item of doc.items || []) {
      if (itemNameSet.has(item.itemName) && item.actualQty != null && item.predictedQty != null) {
        pairsByItem.get(item.itemName).push({ predicted: item.predictedQty, actual: item.actualQty });
      }
    }
  }

  return new Map(
    itemNames.map((itemName) => [
      itemName,
      computeSuggestedStockFromPairs(
        predictedQtyByItem.get(itemName),
        pairsByItem.get(itemName) || [],
        settings
      ),
    ])
  );
};

module.exports = {
  computeSuggestedStockFromPairs, computeSuggestedStockMap,
};
