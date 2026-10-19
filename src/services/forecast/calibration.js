// Forecast calibration: learning factors and the multipliers from recent accuracy.
// Moved from forecast.service.js by BE-11-T04; behaviour unchanged.
const Forecast = require('../../models/Forecast.model');
const { addZonedDays } = require('../../utils/timezone');

const CALIBRATION_LOOKBACK_DAYS = 60;
const OVERALL_SHRINK_PRIOR_DAYS = 10;

const appliedLearningMultiplier = (item) => {
  const learning = (item.factors || []).find((factor) => factor?.key === 'learning');
  const multiplier = Number(learning?.multiplier);
  return learning?.active && Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
};

const rawPredictedQty = (item) => {
  const predicted = Number.isFinite(item.expectedQty) ? item.expectedQty : Number(item.predictedQty);
  return predicted / appliedLearningMultiplier(item);
};
// Sample floors for the learning correction. These were 3, which let a factor
// swing demand double digits off three observations (payday was applying -11.6%
// from n=3). A correction is only worth applying once the evidence behind it
// outweighs ordinary day-to-day variation.
const MIN_OVERALL_CALIBRATION_SAMPLES = 10;
const MIN_FACTOR_CALIBRATION_SAMPLES = 12;
const MIN_ITEM_CALIBRATION_SAMPLES = 20;
// Volume-proportional shrinkage for per-item learning corrections.
// shrink = MAX * units / (units + PRIOR): an item with PRIOR units of predicted
// history gets half of MAX, a very low-volume line gets almost none.
const ITEM_CALIBRATION_MAX_SHRINK = 0.5;
const ITEM_CALIBRATION_VOLUME_PRIOR = 300;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const newBucket = () => ({ sumActual: 0, sumPredicted: 0, sampleSize: 0 });

// Accumulate raw quantities, not per-observation ratios. Averaging ratios
// (even weighted) inflates the result on low-volume items, because for small
// integer counts the ratio distribution is right-skewed: predicting 1 and
// selling 2 gives 2.0, while predicting 2 and selling 1 gives only 0.5.
// A ratio of sums is the unbiased estimator of systematic bias.
const accumulateTotals = (bucket, actual, predicted) => {
  bucket.sumActual += actual;
  bucket.sumPredicted += predicted;
  bucket.sampleSize += 1;
};

const bucketRatio = (bucket) =>
  (bucket.sumPredicted > 0 ? clamp(bucket.sumActual / bucket.sumPredicted, 0.25, 2) : 1);

const calibratedMultiplier = (averageRatio, shrink, min, max) =>
  clamp(1 + (averageRatio - 1) * shrink, min, max);

const buildLearningFactor = (multiplier, sampleSize, options = {}) => {
  const enabled = options.enabled !== false;
  const measuredPct = (multiplier - 1) * 100;
  const hasEvidence = enabled && sampleSize >= MIN_OVERALL_CALIBRATION_SAMPLES;
  // Applied only when the correction is switched on AND large enough to matter.
  const applied = hasEvidence && Math.abs(measuredPct) >= 1;

  const formattedBias = `${measuredPct > 0 ? '+' : ''}${Number(measuredPct.toFixed(1))}%`;
  let effect;
  if (applied) effect = formattedBias;
  else if (hasEvidence && Math.abs(measuredPct) >= 1) effect = `${formattedBias} measured, not applied`;
  else effect = 'no effect';

  let reason;
  if (!enabled) {
    reason = options.reason || 'Upgrade to Pro to apply learning corrections';
  } else if (!hasEvidence) {
    reason = sampleSize > 0
      ? `${sampleSize} matched days so far; ${MIN_OVERALL_CALIBRATION_SAMPLES} needed`
      : 'not enough history yet';
  } else if (!applied) {
    reason = `Tracking a ${formattedBias} bias over ${sampleSize} days — too small to act on.`;
  } else {
    reason = `${sampleSize} matched historical item outcomes`;
  }

  return {
    key: 'learning',
    label: 'Learning correction',
    active: applied,
    measuredPct: hasEvidence ? Number(measuredPct.toFixed(2)) : 0,
    sampleSize,
    adjustmentPct: applied ? Number(measuredPct.toFixed(2)) : 0,
    multiplier: applied ? Number(multiplier.toFixed(4)) : 1,
    effect,
    reason,
  };
};

const computeForecastCalibration = async (cafeId, targetDate, timezone) => {
  const lookbackStart = addZonedDays(targetDate, -CALIBRATION_LOOKBACK_DAYS, timezone);

  const pastForecasts = await Forecast.find({
    calibrationExcluded: { $ne: true },
    cafeId,
    date: { $gte: lookbackStart, $lt: targetDate },
    actualsUpdatedAt: { $exists: true, $ne: null },
    origin: { $ne: 'backfill' },
    'availability.status': { $ne: 'insufficient_data' },
  })
    .select('date items')
    .lean();

  return calibrationFromForecasts(pastForecasts);
};

const calibrationFromForecasts = (pastForecasts) => {
  const overall = newBucket();
  const factorBuckets = new Map();
  const itemBuckets = new Map();
  const dailyObservations = [];
  const itemObservations = [];

  for (const forecast of pastForecasts) {
    let dailyPredicted = 0;
    let dailyActual = 0;
    let hasActual = false;
    const dailyFactorTotals = new Map();

    for (const item of forecast.items || []) {
      const predicted = rawPredictedQty(item);
      if (item.actualQty == null || !Number.isFinite(predicted) || predicted <= 0) continue;

      const activeFactors = (item.factors || []).filter((factor) => factor.active && factor.key !== 'learning');

      dailyPredicted += predicted;
      dailyActual += item.actualQty;
      hasActual = true;
      itemObservations.push({
        actual: item.actualQty,
        predicted,
        itemName: item.itemName,
      });
      for (const activeFactor of activeFactors) {
        if (!dailyFactorTotals.has(activeFactor.key)) {
          dailyFactorTotals.set(activeFactor.key, {
            key: activeFactor.key, label: activeFactor.label, actual: 0, predicted: 0,
          });
        }
        const totals = dailyFactorTotals.get(activeFactor.key);
        totals.actual += item.actualQty;
        totals.predicted += predicted;
      }
    }

    if (hasActual && dailyPredicted > 0) {
      accumulateTotals(overall, dailyActual, dailyPredicted);
      dailyObservations.push({
        factorTotals: [...dailyFactorTotals.values()],
      });
    }
  }

  const rawOverallRatio = bucketRatio(overall);
  const overallShrink = overall.sampleSize / (overall.sampleSize + OVERALL_SHRINK_PRIOR_DAYS);
  const overallMultiplier = overall.sampleSize >= MIN_OVERALL_CALIBRATION_SAMPLES
    ? calibratedMultiplier(rawOverallRatio, overallShrink, 0.85, 1.15)
    : 1;

  // Residual = how much this slice deviates AFTER the overall bias is removed,
  // so the overall correction is not counted twice when the two are multiplied.
  const residualise = (ratio) =>
    (rawOverallRatio > 0 ? clamp(ratio / rawOverallRatio, 0.25, 2) : ratio);

  for (const observation of itemObservations) {
    if (!observation.itemName) continue;
    if (!itemBuckets.has(observation.itemName)) {
      itemBuckets.set(observation.itemName, newBucket());
    }
    accumulateTotals(itemBuckets.get(observation.itemName), observation.actual, observation.predicted);
  }

  // A factor receives at most one observation per trading day. Counting every
  // item as a separate sample would create false confidence from one outcome.
  for (const observation of dailyObservations) {
    for (const totals of observation.factorTotals) {
      if (totals.predicted <= 0) continue;
      if (!factorBuckets.has(totals.key)) {
        factorBuckets.set(totals.key, {
          key: totals.key,
          label: totals.label,
          ...newBucket(),
        });
      }
      accumulateTotals(factorBuckets.get(totals.key), totals.actual, totals.predicted);
    }
  }

  const factorMultipliers = [...factorBuckets.values()]
    .filter((bucket) => bucket.sampleSize >= MIN_FACTOR_CALIBRATION_SAMPLES && bucket.sumPredicted > 0)
    .map((bucket) => {
      const averageRatio = residualise(bucketRatio(bucket));
      return {
        key: bucket.key,
        label: bucket.label,
        multiplier: Number(calibratedMultiplier(averageRatio, 0.6, 0.8, 1.2).toFixed(4)),
        sampleSize: bucket.sampleSize,
        averageRatio: Number(averageRatio.toFixed(4)),
      };
    });

  const itemMultipliers = [...itemBuckets.entries()]
    .filter(([, bucket]) => bucket.sampleSize >= MIN_ITEM_CALIBRATION_SAMPLES && bucket.sumPredicted > 0)
    .map(([itemName, bucket]) => {
      const averageRatio = residualise(bucketRatio(bucket));
      // Trust an item's own correction in proportion to the volume behind it.
      // A line selling ~1/day produces a ratio that is mostly noise, so pulling
      // it hard toward 1 avoids importing that noise into tomorrow's forecast.
      const shrink = ITEM_CALIBRATION_MAX_SHRINK
        * (bucket.sumPredicted / (bucket.sumPredicted + ITEM_CALIBRATION_VOLUME_PRIOR));
      return {
        itemName,
        multiplier: Number(calibratedMultiplier(averageRatio, shrink, 0.8, 1.2).toFixed(4)),
        sampleSize: bucket.sampleSize,
        observedUnits: bucket.sumActual,
        shrink: Number(shrink.toFixed(3)),
        averageRatio: Number(averageRatio.toFixed(4)),
      };
    });

  return {
    lookbackDays: CALIBRATION_LOOKBACK_DAYS,
    sampleSize: overall.sampleSize,
    overallMultiplier: Number(overallMultiplier.toFixed(4)),
    factorMultipliers,
    itemMultipliers,
    generatedAt: new Date(),
  };
};

const calibrationMultiplierForItem = (calibration, itemName, factors) => {
  let multiplier = calibration.overallMultiplier || 1;

  const itemCalibration = (calibration.itemMultipliers || []).find((entry) => entry.itemName === itemName);
  if (itemCalibration) multiplier *= itemCalibration.multiplier;

  // Active factors on one day are confounded. Apply only the strongest learned
  // residual instead of multiplying several corrections learned from the same
  // underlying outcome.
  const factorCalibration = factors
    .filter((factor) => factor.active)
    .map((factor) => (calibration.factorMultipliers || []).find((entry) => entry.key === factor.key))
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1))[0];
  if (factorCalibration) multiplier *= factorCalibration.multiplier;

  return clamp(multiplier, 0.7, 1.3);
};

module.exports = {
  appliedLearningMultiplier, rawPredictedQty, OVERALL_SHRINK_PRIOR_DAYS,
  CALIBRATION_LOOKBACK_DAYS, clamp, buildLearningFactor, calibrationFromForecasts, computeForecastCalibration, calibrationMultiplierForItem,
};
