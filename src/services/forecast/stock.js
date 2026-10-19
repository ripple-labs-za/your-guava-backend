// Suggested stock from predicted quantities.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Forecast = require('../../models/Forecast.model');
const { zonedDayStart, addZonedDays } = require('../../utils/timezone');

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

const loadStockPairs = async (cafeId, target, timezone, itemNames) => {
  const pairsByItem = new Map(itemNames.map((name) => [name, []]));
  if (itemNames.length === 0) return pairsByItem;
  const docs = await Forecast.find({
    cafeId,
    date: { $gte: addZonedDays(target, -30, timezone), $lt: target },
    'items.itemName': { $in: itemNames },
    'items.actualQty': { $exists: true, $ne: null },
    calibrationExcluded: { $ne: true },
  }).select('items.itemName items.predictedQty items.actualQty').lean();
  for (const doc of docs) {
    for (const item of doc.items || []) {
      if (pairsByItem.has(item.itemName) && item.actualQty != null && item.predictedQty != null) {
        pairsByItem.get(item.itemName).push({ predicted: item.predictedQty, actual: item.actualQty });
      }
    }
  }
  return pairsByItem;
};

const computeSuggestedStockMap = async (
  cafeId,
  predictedQtyByItem,
  settings,
  targetDate = new Date(),
  timezone = 'Africa/Johannesburg',
  { pairsByItem: givenPairs } = {}
) => {
  const itemNames = [...predictedQtyByItem.keys()];
  if (itemNames.length === 0) return new Map();

  const pairsByItem = givenPairs || await loadStockPairs(cafeId, zonedDayStart(targetDate, timezone), timezone, itemNames);

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
  loadStockPairs, computeSuggestedStockFromPairs, computeSuggestedStockMap,
};
