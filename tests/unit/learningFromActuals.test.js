// Release 3 (owner, 3 Nov): "we need to adjust predictions as actual data is received". These prove the engine learns
// from scored days: the forecast moves toward what was sold, factor effects are shrunk toward the defaults by sample
// size, the owner's own factor settings win, and the overall correction runs on every plan (L-5).
const {
  calibrationFromForecasts, calibrationMultiplierForItem, MIN_OVERALL_CALIBRATION_SAMPLES, FACTOR_SHRINK_PRIOR_DAYS,
} = require('../../src/services/forecast/calibration');
const { learningPolicy } = require('../../src/services/forecast/generate');

const PREDICTED = 100;
// One scored day: a single item predicted PREDICTED units, `ratio` times that sold, with the given active factors.
const scoredDay = (ratio, factors = []) => ({
  date: new Date(),
  items: [{ itemName: 'Flat White', expectedQty: PREDICTED, predictedQty: PREDICTED, actualQty: PREDICTED * ratio,
    factors: factors.map((key) => ({ key, label: key, active: true, multiplier: 1.1 })) }],
});
const days = (n, ratio, factors) => Array.from({ length: n }, () => scoredDay(ratio, factors));

describe('a forecast moves toward actuals as days are scored', () => {
  it('changes nothing before enough days are scored, then moves the plan toward what sold', () => {
    const tooFew = calibrationFromForecasts(days(MIN_OVERALL_CALIBRATION_SAMPLES - 1, 1.3));
    expect(tooFew.overallMultiplier).toBe(1);

    const enough = calibrationFromForecasts(days(14, 1.3));
    const learned = calibrationMultiplierForItem(enough, 'Flat White', []);
    const nextForecast = PREDICTED * learned;
    // Closer to the 130 that kept selling, without overshooting it, and within the bounded correction.
    expect(nextForecast).toBeGreaterThan(PREDICTED);
    expect(Math.abs(130 - nextForecast)).toBeLessThan(Math.abs(130 - PREDICTED));
    expect(nextForecast).toBeLessThanOrEqual(130);
    expect(learned).toBeLessThanOrEqual(1.3);
  });

  it('moves further as more scored days agree (shrinkage by sample size)', () => {
    const after12 = calibrationFromForecasts(days(12, 0.85)).overallMultiplier;
    const after40 = calibrationFromForecasts(days(40, 0.85)).overallMultiplier;
    expect(after12).toBeLessThan(1);
    expect(after40).toBeLessThan(after12);
  });
});

describe('the whole menu counts (L-3)', () => {
  it('measures the overall bias on the full-menu totals, not only the stored top items', () => {
    // The stored top items sold exactly as forecast, but the long tail sold 60% above: full menu 200 raw vs 260 sold.
    const day = () => ({ ...scoredDay(1), forecastCoverage: { totalRawPredictedQty: 200, totalActualQty: 260 } });
    const fullMenu = calibrationFromForecasts(Array.from({ length: 14 }, day));
    const topItemsOnly = calibrationFromForecasts(days(14, 1));
    expect(topItemsOnly.overallMultiplier).toBe(1);
    expect(fullMenu.overallMultiplier).toBeGreaterThan(1);
  });

  it('scoring records everything sold against the full menu, and clears it when the sales go', () => {
    const { scoreForecastDay } = require('../../src/services/forecast/actuals');
    const doc = {
      items: [{ itemName: 'Flat White', expectedQty: 10, predictedQty: 10, factors: [] }],
      forecastCoverage: { totalPredictedQty: 12, totalRawPredictedQty: 12, includesAllRevenue: true, predictedItemNames: ['Flat White', 'Scone'] },
      set(pathName, value) { const [head, tail] = pathName.split('.'); this[head] = { ...this[head], [tail]: value }; },
      markModified() {},
    };
    const sale = (name, quantity) => ({ total: 30, items: [{ name, quantity, unitPrice: 30 }] });
    expect(scoreForecastDay(doc, [sale('Flat White', 9), sale('Scone', 4)], { itemIndex: new Map() })).toBe('scored');
    expect(doc.forecastCoverage.totalActualQty).toBe(13);
    expect(scoreForecastDay(doc, [], { itemIndex: new Map() })).toBe('cleared');
    expect(doc.forecastCoverage.totalActualQty).toBeUndefined();
  });

  it('falls back to the stored items for forecasts made before the totals were recorded', () => {
    const legacy = calibrationFromForecasts(days(14, 1.3));
    expect(legacy.overallMultiplier).toBeGreaterThan(1);
  });
});

describe("per-cafe factor effects (L-1)", () => {
  it('trusts a factor effect in proportion to its scored days', () => {
    // Weather days sold 20% above the forecast while the rest matched it. The same mix at both sizes, so the measured
    // effect (relative to the overall bias) is the same and only the evidence behind it grows.
    const mixed = (n) => [...days(n, 1), ...days(n, 1.2, ['weather'])];
    const few = calibrationFromForecasts(mixed(12)).factorMultipliers.find((entry) => entry.key === 'weather');
    const many = calibrationFromForecasts(mixed(60)).factorMultipliers.find((entry) => entry.key === 'weather');
    expect(few.shrink).toBeCloseTo(12 / (12 + FACTOR_SHRINK_PRIOR_DAYS), 3);
    expect(many.shrink).toBeGreaterThan(few.shrink);
    expect(many.multiplier).toBeGreaterThan(few.multiplier);
    expect(few.multiplier).toBeGreaterThan(1);
  });

  it('never learns an effect for the combined-factor bound', () => {
    const calibration = calibrationFromForecasts(days(30, 1.2, ['factorLimit']));
    expect(calibration.factorMultipliers.find((entry) => entry.key === 'factorLimit')).toBeUndefined();
  });

  it("keeps the owner's own effect for a factor they set by hand", () => {
    const calibration = calibrationFromForecasts([...days(20, 1), ...days(40, 1.2, ['weather'])]);
    const factors = [{ key: 'weather', active: true }];
    const learned = calibrationMultiplierForItem(calibration, 'Flat White', factors);
    const ownerSet = calibrationMultiplierForItem(calibration, 'Flat White', factors, { ownerOverrides: new Set(['weather']) });
    expect(learned).toBeGreaterThan(ownerSet);
    expect(ownerSet).toBeCloseTo(calibration.overallMultiplier, 4);
  });
});

describe('who learns what (L-5)', () => {
  it('runs the overall correction on every plan, and per-factor learning on Pro', () => {
    expect(learningPolicy({}, 'starter')).toMatchObject({ learningEnabled: false, biasCorrectionEnabled: true });
    expect(learningPolicy({}, 'pro')).toMatchObject({ learningEnabled: true, biasCorrectionEnabled: true });
  });

  // W-04 (walk): Starter cafes carry a stored learning.enabled=false they could never have set (the switch is Pro-only).
  it('runs the overall correction on a Starter cafe whose stored settings say learning is off', () => {
    expect(learningPolicy({ forecastSettings: { learning: { enabled: false } } }, 'starter'))
      .toMatchObject({ learningEnabled: false, biasCorrectionEnabled: true });
  });

  it('stops learning when the owner switches it off', () => {
    expect(learningPolicy({ forecastSettings: { learning: { enabled: false } } }, 'pro'))
      .toMatchObject({ learningEnabled: false, biasCorrectionEnabled: false });
  });

  it('lists the factors whose effect the owner changed from the default', () => {
    const { ownerOverrides } = learningPolicy({ forecastSettings: { weather: { rainPct: -25 }, payday: {} } }, 'pro');
    expect([...ownerOverrides]).toEqual(['weather']);
  });
});
