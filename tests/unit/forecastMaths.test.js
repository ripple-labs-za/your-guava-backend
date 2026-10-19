const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const Event = require('../../src/models/Event.model');
const Item = require('../../src/models/Item.model');
const Forecast = require('../../src/models/Forecast.model');
const { generateForecast, _test: forecastMath } = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart, zonedDateKey } = require('../../src/utils/timezone');

const TZ = 'Africa/Johannesburg';
// A Wednesday with no public holiday, payday or school calendar (2030 has none), so every target factor is neutral.
const TARGET = zonedDayStart('2030-03-06', TZ);

// A Mongoose-like query that resolves to `value` however it is chained or awaited.
const query = (value) => {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    session: () => chain,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
};

// The Wednesday k weeks before TARGET at 10:00 cafe time (Johannesburg has no daylight saving).
const weeksAgo = (k) => new Date(addZonedDays(TARGET, -7 * k, TZ).getTime() + 10 * 60 * 60 * 1000);
const sale = (k, items) => ({ date: weeksAgo(k), dayOfWeek: 3, hour: 10, status: 'approved', items });
const line = (name, quantity, unitPrice) => ({ name, quantity, unitPrice });

// Every read generateForecast makes is stubbed. An unstubbed model call waits on Mongoose buffering for 10 s:
// if a test here times out, that is the cause.
const stubModels = ({
  plan = 'starter', transactions = [], items = [], events = [], storedSignals = [], calibrationDocs = [],
} = {}) => {
  jest.spyOn(Cafe, 'findById').mockReturnValue(query({
    _id: 'cafe-1', orgId: 'org-1', timezone: TZ, forecastSettings: { learning: { enabled: plan === 'pro' } },
  }));
  jest.spyOn(Organization, 'findById').mockReturnValue(query({ plan }));
  jest.spyOn(Transaction, 'find').mockReturnValue(query(transactions));
  jest.spyOn(Transaction, 'findOne').mockReturnValue(query(null));
  jest.spyOn(Event, 'find').mockReturnValue(query(events));
  jest.spyOn(Item, 'find').mockReturnValue(query(items));
  jest.spyOn(Forecast, 'find').mockImplementation((filter = {}) => {
    // The batch loader reads all outcomes once, then applies the scored/live
    // filter per target day. Model fixtures must carry the persisted score time.
    if (filter.calibrationExcluded) return query(calibrationDocs.map((doc) => ({ actualsUpdatedAt: doc.date, ...doc })));
    if (filter.dateKey) return query(storedSignals); // loadStoredSignalsByDateKey
    return query([]); // computeSuggestedStockMap
  });
  jest.spyOn(Forecast, 'findOne').mockReturnValue(query(null));
  jest.spyOn(Forecast, 'findOneAndUpdate').mockImplementation(async (_filter, update) => update.$set);
};

const itemNamed = (forecast, name) => forecast.items.find((item) => item.itemName === name);

afterEach(() => jest.restoreAllMocks());

describe('forecast totals', () => {
  it('rounds the persisted expected quantity consistently at a half-unit boundary', async () => {
    stubModels({
      transactions: Array.from({ length: 8 }, (_, i) => sale(i + 1, [line('Tail', 0.49996, 20)])),
      items: [{ name: 'Tail', category: 'food', avgPrice: 20 }],
    });
    const forecast = await generateForecast('cafe-1', TARGET);
    const item = itemNamed(forecast, 'Tail');
    expect(item.expectedQty).toBe(0.5);
    expect(item.predictedQty).toBe(Math.round(item.expectedQty));
  });

  it('sums the long tail before rounding', async () => {
    const transactions = [];
    for (let k = 1; k <= 8; k += 1) transactions.push(sale(k, [line('Flat White', 10, 30)]));
    // Twelve lines that each sold once, last week only: a weighted average of exactly 0.35 each.
    for (let n = 1; n <= 12; n += 1) transactions.push(sale(1, [line(`Tail ${n}`, 1, 20)]));
    stubModels({
      transactions,
      items: [
        { name: 'Flat White', category: 'coffee', avgPrice: 30 },
        ...Array.from({ length: 12 }, (_, i) => ({ name: `Tail ${i + 1}`, category: 'food', avgPrice: 20 })),
      ],
    });

    const forecast = await generateForecast('cafe-1', TARGET);

    expect(itemNamed(forecast, 'Tail 1').predictedQty).toBe(0);
    expect(itemNamed(forecast, 'Tail 1').expectedQty).toBeCloseTo(0.35, 4);
    // 10 flat whites + 12 x 0.35; the integer sum said 10.
    expect(forecast.forecastCoverage.totalPredictedQty).toBeCloseTo(14.2, 2);
    // R300 of coffee + 12 x 0.35 x R20; the integer sum said R300.
    expect(forecast.totalPredictedRevenue).toBeCloseTo(384, 2);
  });
});

describe('forecast baseline', () => {
  it('does not remove a past event uplift when the plan locks that factor', async () => {
    const transactions = [sale(1, [line('Flat White', 30, 30)])];
    for (let k = 2; k <= 8; k += 1) transactions.push(sale(k, [line('Flat White', 20, 30)]));
    stubModels({
      plan: 'starter', transactions, items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      events: [{ name: 'Market', type: 'event', impact: 'high', impactPct: 50, date: new Date(Date.UTC(2030, 1, 27)) }],
    });
    const forecast = await generateForecast('cafe-1', TARGET);
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(23.5);
  });

  it('divides a past event uplift out of the baseline', async () => {
    const transactions = [sale(1, [line('Flat White', 30, 30)])];
    for (let k = 2; k <= 8; k += 1) transactions.push(sale(k, [line('Flat White', 20, 30)]));
    stubModels({
      plan: 'growth', // events are a Growth factor
      transactions,
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      // Last Wednesday's market, stored the way POST /api/events stores a date: UTC midnight of the typed day.
      events: [{ name: 'Market', type: 'event', impact: 'high', impactPct: 50, date: new Date(Date.UTC(2030, 1, 27)) }],
    });

    const forecast = await generateForecast('cafe-1', TARGET);

    // 30 / 1.5 = 20 on the market day. Undivided, the recent week adds 0.35 x 10 and the baseline reads 23.5.
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(20);
    expect(itemNamed(forecast, 'Flat White').expectedQty).toBeCloseTo(20, 4);
    expect(forecast.signals.events).toEqual([]);
  });

  it('divides stored cold weather out of the baseline', async () => {
    const transactions = [];
    for (let k = 1; k <= 8; k += 1) transactions.push(sale(k, [line('Flat White', 23, 30)]));
    const cold = { available: true, temp: 12, maxTemp: 12, condition: 'Cloudy', humidity: 70, isRain: false };
    stubModels({
      transactions,
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      storedSignals: Array.from({ length: 8 }, (_, i) => ({
        dateKey: zonedDateKey(weeksAgo(i + 1), TZ),
        signals: { weather: cold },
      })),
    });

    const forecast = await generateForecast('cafe-1', TARGET);

    // Eight cold Wednesdays at +15% coffee: 23 / 1.15 = 20. The target day's weather is unknown, so nothing is re-applied.
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(20);
  });

  it('caps a one-off spike and leaves an intermittent line alone', async () => {
    const transactions = [sale(1, [line('Flat White', 60, 30)])];
    for (let k = 2; k <= 8; k += 1) transactions.push(sale(k, [line('Flat White', 20, 30)]));
    for (const k of [1, 3, 5, 7]) transactions.push(sale(k, [line('Scone', 2, 25)]));
    stubModels({
      transactions,
      items: [
        { name: 'Flat White', category: 'coffee', avgPrice: 30 },
        { name: 'Scone', category: 'food', avgPrice: 25 },
      ],
    });

    const forecast = await generateForecast('cafe-1', TARGET);

    // Median 20, cap 1.5 x 20 = 30: 0.35 x 30 + 0.65 x 20 = 23.5. Uncapped it reads 0.35 x 60 + 0.65 x 20 = 34.
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(23.5);
    // Median 1 is under the 3-unit floor, so the 2,0,2,0 pattern is not trimmed: 2 x (0.35 + 0.20 + 0.04 + 0.04) = 1.26.
    expect(itemNamed(forecast, 'Scone').baseQty).toBe(1.26);
  });
});

describe('forecast arithmetic boundaries', () => {
  const { storedDayKey } = require('../../src/utils/timezone');
  const { rawPredictedQty, appliedLearningMultiplier } = require('../../src/services/forecast/calibration');

  it('leaves missing quantities and nonpositive or nonfinite multipliers safe', () => {
    for (const multiplier of [0, -1, Infinity, NaN]) {
      expect(forecastMath.deFactorItemBuckets([null, 10], ['a', 'b'], () => multiplier)).toEqual([null, 10]);
    }
    expect(forecastMath.deFactorItemBuckets([null, 10], ['a', 'b'], () => 2)).toEqual([null, 5]);
  });

  it('keeps date-only and cafe-local storage shapes on the same owner day', () => {
    expect(storedDayKey(new Date('2030-03-06T00:00:00Z'), TZ)).toBe('2030-03-06');
    expect(storedDayKey(new Date('2030-03-05T22:00:00Z'), TZ)).toBe('2030-03-06');
    expect(storedDayKey('invalid', TZ)).toBeNull();
  });

  it('caps the exact median floor but preserves steadily rising demand', () => {
    expect(forecastMath.winsoriseBuckets([100, 3, 3, 3])).toEqual([4.5, 3, 3, 3]);
    const rising = [24, 22, 20, 18, 16, 14, 12, 10];
    expect(forecastMath.winsoriseBuckets(rising)).toEqual(rising);
  });

  it('reads legacy predictions without dividing by absent, inactive or invalid learning', () => {
    for (const factor of [undefined, { active: false, multiplier: 2 }, { active: true, multiplier: 0 }]) {
      const item = { predictedQty: 11, factors: factor ? [{ key: 'learning', ...factor }] : undefined };
      expect(appliedLearningMultiplier(item)).toBe(1);
      expect(rawPredictedQty(item)).toBe(11);
    }
    expect(rawPredictedQty({ expectedQty: 0, predictedQty: 11 })).toBe(0);
  });
});

describe('learning correction', () => {
  const learningFactor = (multiplier) => ({ key: 'learning', label: 'Learning correction', active: true, multiplier });

  it('recovers a known 12% under-forecast within 5%', async () => {
    const transactions = [];
    for (let k = 1; k <= 8; k += 1) transactions.push(sale(k, [line('Flat White', 25, 30)]));
    // Sixty scored days: the raw baseline was 25, a previous correction of 1.04 made it 26, the cafe sold 28 (true bias 1.12).
    const calibrationDocs = Array.from({ length: 60 }, (_, i) => ({
      date: addZonedDays(TARGET, -(i + 1), TZ),
      items: [{
        itemName: 'Flat White', predictedQty: 26, expectedQty: 26, actualQty: 28, factors: [learningFactor(1.04)],
      }],
    }));
    stubModels({
      plan: 'pro',
      transactions,
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      calibrationDocs,
    });

    const forecast = await generateForecast('cafe-1', TARGET);
    const flatWhite = itemNamed(forecast, 'Flat White');

    // Raw ratio 28 / (26 / 1.04) = 1.12; shrink 60 / (60 + 10); 1 + 0.12 x 0.857 = 1.1029.
    expect(forecast.calibration.overallMultiplier).toBe(1.1029);
    // 25 x 1.1029 = 27.57 against a true 28: 1.5% off. The old loop reached 25.96 (7.3% off).
    expect(Math.abs(flatWhite.expectedQty - 28) / 28).toBeLessThan(0.05);
  });

  it('divides the stored learning multiplier out before measuring (WS-08-T05)', async () => {
    stubModels({
      plan: 'pro',
      calibrationDocs: Array.from({ length: 10 }, (_, i) => ({
        date: addZonedDays(TARGET, -(i + 1), TZ),
        // A legacy row with no expectedQty: 11 was 10 x 1.10, and the day sold exactly 10.
        items: [{ itemName: 'Flat White', predictedQty: 11, actualQty: 10, factors: [learningFactor(1.1)] }],
      })),
    });

    const calibration = await forecastMath.computeForecastCalibration('cafe-1', TARGET, TZ);

    // Measured against its own corrected output the loop would read 10/11 and shrink to 0.9545.
    expect(calibration.overallMultiplier).toBe(1);
  });

  it('learns a factor correction only from the items it applies to', async () => {
    const weatherOn = { key: 'weather', label: 'Weather', active: true, multiplier: 1.3 };
    const weatherOff = { key: 'weather', label: 'Weather', active: false, multiplier: 1 };
    stubModels({
      plan: 'pro',
      calibrationDocs: Array.from({ length: 12 }, (_, i) => ({
        date: addZonedDays(TARGET, -(i + 1), TZ),
        items: [
          // Cold drinks carry the hot-day factor and still sell 40% over it.
          { itemName: 'Iced Latte', predictedQty: 10, expectedQty: 10, actualQty: 14, factors: [weatherOn] },
          // Food has no weather factor and is exact.
          { itemName: 'Toastie', predictedQty: 90, expectedQty: 90, actualQty: 90, factors: [weatherOff] },
        ],
      })),
    });

    const calibration = await forecastMath.computeForecastCalibration('cafe-1', TARGET, TZ);
    const weather = calibration.factorMultipliers.find((entry) => entry.key === 'weather');

    // Iced latte alone: 168 / 120 = 1.4; over the day's 104 / 100 = 1.3462; 1 + 0.3462 x 0.6 capped at 1.2.
    // The whole-day bucket read 104 / 100, residual 1.0, and learned nothing.
    expect(weather).toEqual(expect.objectContaining({ multiplier: 1.2, averageRatio: 1.3462, sampleSize: 12 }));
  });
});

describe('bounded forecast maths review regressions', () => {
  it.each([
    [[20, 20, 20, 5, 5, 5, 5, 5], 17],
    [[12, 10, 10, 4, 4, 4, 4, 4], 9.5],
  ])('keeps a sustained recent level %j', async (quantities, expected) => {
    stubModels({
      transactions: quantities.map((qty, i) => sale(i + 1, [line('Flat White', qty, 30)])),
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
    });
    const forecast = await generateForecast('cafe-1', TARGET);
    expect(forecastMath.winsoriseBuckets(quantities)).toEqual(quantities);
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(expected);
  });

  it('uses neighbouring observed weeks across missing buckets when identifying one-off spikes', () => {
    expect(forecastMath.winsoriseBuckets([20, null, 20, 5, 5, 5, 5, 5]))
      .toEqual([20, null, 20, 5, 5, 5, 5, 5]);
    expect(forecastMath.winsoriseBuckets([5, null, 20, null, 5, 5, 5, 5]))
      .toEqual([5, null, 7.5, null, 5, 5, 5, 5]);
  });

  it('does not apply learning that its stored factor calls inactive', async () => {
    stubModels({
      plan: 'pro',
      transactions: Array.from({ length: 8 }, (_, i) => sale(i + 1, [line('Flat White', 100, 30)])),
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      calibrationDocs: Array.from({ length: 10 }, (_, i) => ({
        date: addZonedDays(TARGET, -(i + 1), TZ),
        items: [{ itemName: 'Flat White', predictedQty: 100, expectedQty: 100, actualQty: 101 }],
      })),
    });
    const forecast = await generateForecast('cafe-1', TARGET);
    const item = itemNamed(forecast, 'Flat White');
    expect(item.factors.find((factor) => factor.key === 'learning'))
      .toEqual(expect.objectContaining({ active: false, multiplier: 1 }));
    expect(item.expectedQty).toBe(100);
    const { rawPredictedQty } = require('../../src/services/forecast/calibration');
    expect(rawPredictedQty(item)).toBe(100);
  });

  it.each([
    ['16:30', 2], // 5% open: missing, never inflate 2 into40.
    ['12:00', 10], // 50% open: remains usable and is divided back to20.
  ])('handles historical partial closure ending %s with a bounded baseline', async (endTime, recentQty) => {
    stubModels({
      plan: 'growth',
      transactions: Array.from({ length: 8 }, (_, i) => ({
        ...sale(i + 1, [line('Flat White', i === 0 ? recentQty : 20, 30)]), hourKnown: false,
      })),
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      events: [{ name: 'Plumber', type: 'partial_closure', date: new Date(Date.UTC(2030, 1, 27)),
        closureWindow: { startTime: '07:00', endTime } }],
    });
    Cafe.findById.mockReturnValue(query({
      _id: 'cafe-1', orgId: 'org-1', timezone: TZ,
      tradingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: true, openTime: '07:00', closeTime: '17:00' })),
    }));
    const forecast = await generateForecast('cafe-1', TARGET);
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(20);
  });

  it('divides stored verified stage4 load shedding out of the history baseline', async () => {
    stubModels({
      plan: 'growth',
      transactions: Array.from({ length: 8 }, (_, i) => sale(i + 1, [line('Flat White', 15.6, 30)])),
      items: [{ name: 'Flat White', category: 'coffee', avgPrice: 30 }],
      storedSignals: Array.from({ length: 8 }, (_, i) => ({
        dateKey: zonedDateKey(weeksAgo(i + 1), TZ),
        signals: { loadSheddingAvailable: true, loadSheddingStage: 4 },
      })),
    });
    const forecast = await generateForecast('cafe-1', TARGET);
    expect(itemNamed(forecast, 'Flat White').baseQty).toBe(20);
  });
});
