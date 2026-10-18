const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const Transaction = require('../../src/models/Transaction.model');
const { updateForecastActuals, BACKTEST_BASIS_NOTE } = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart, zonedDateKey } = require('../../src/utils/timezone');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const TZ = 'Africa/Johannesburg';
const localDay = (daysAgo) => addZonedDays(zonedDayStart(new Date(), TZ), -daysAgo, TZ);
const at = (day, hour) => new Date(day.getTime() + hour * 60 * 60 * 1000);
const quietSignals = {
  weather: { temp: 20, condition: 'clear', humidity: 60 },
  loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [],
};
// What needsHistoryForecastRefresh requires before a backfilled row is shown.
const planningPayload = {
  factors: ['weather', 'loadShedding', 'holiday', 'payday', 'events'].map((key) => ({ key, label: key, active: false })),
  factorSettings: { weather: { enabled: true } },
  factorEntitlements: { plan: 'starter' },
  calibration: { sampleSize: 0, overallMultiplier: 1, factorMultipliers: [], itemMultipliers: [] },
};

const scoredDay = (cafeId, daysAgo, { origin = 'live', status = 'ready', accuracy = 90, itemAccuracy } = {}) =>
  Forecast.create({
    cafeId,
    date: localDay(daysAgo),
    dateKey: zonedDateKey(localDay(daysAgo), TZ),
    generatedAt: new Date(),
    origin,
    availability: { status, reason: status === 'insufficient_data' ? 'At least 3 observed matching trading days are required; 1 available' : '' },
    items: [{ itemName: 'Flat White', predictedQty: 3, actualQty: 3, factors: [{ key: 'weather', label: 'Weather', active: false }] }],
    signals: quietSignals,
    ...planningPayload,
    totalPredictedRevenue: 100,
    actualRevenue: 100,
    actualTransactionCount: 1,
    actualsUpdatedAt: new Date(),
    accuracy,
    ...(itemAccuracy != null ? { itemAccuracy } : {}),
  });

describe('forecast accuracy honesty', () => {
  let token;
  let cafe;

  beforeEach(async () => {
    ({ token } = await createTestUser());
    cafe = await Cafe.findOne({});
  });

  it('leaves days the product called insufficient_data out of the headline accuracy', async () => {
    for (let d = 1; d <= 5; d += 1) await scoredDay(cafe._id, d, { accuracy: 90 });
    for (let d = 6; d <= 8; d += 1) await scoredDay(cafe._id, d, { status: 'insufficient_data', accuracy: 40 });
    await scoredDay(cafe._id, 40, { status: 'insufficient_data', accuracy: 40 });
    const unscored = await scoredDay(cafe._id, 9, { status: 'insufficient_data', accuracy: 40 });
    await Forecast.updateOne({ _id: unscored._id }, { $unset: { actualsUpdatedAt: 1 } });

    const res = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // (5 x 90 + 3 x 40) / 8 = 71.3 when the disowned days are counted.
    expect(res.body).toEqual(expect.objectContaining({ basis: 'live', liveCount: 5, avgAccuracy: 90, excludedInsufficientDays: 3 }));
  });

  it.each([
    [50, 50, 100],
    [30, 30, 60],
    [70, 70, 60],
  ])('scores merged predictions %s + %s against canonical actuals', async (oldPrediction, rootPrediction, expectedAccuracy) => {
    const Item = require('../../src/models/Item.model');
    const day = localDay(1);
    const [oldItem, root] = await Item.create([
      { cafeId: cafe._id, name: 'Flat White Old', normalizedName: 'flat white old', reviewStatus: 'merged' },
      { cafeId: cafe._id, name: 'Flat White', normalizedName: 'flat white', reviewStatus: 'matched' },
    ]);
    await Item.updateOne({ _id: oldItem._id }, { mergedInto: root._id });
    await Forecast.create({
      cafeId: cafe._id, date: day, generatedAt: new Date(), signals: quietSignals, totalPredictedRevenue: 0,
      items: [
        { itemName: 'Flat White Old', salesItemId: oldItem._id, predictedQty: oldPrediction, expectedQty: oldPrediction },
        { itemName: 'Flat White', salesItemId: root._id, predictedQty: rootPrediction, expectedQty: rootPrediction },
      ],
      forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: oldPrediction + rootPrediction, includesAllRevenue: true },
    });
    await Transaction.create({
      cafeId: cafe._id, date: at(day, 10), hour: 10, dayOfWeek: 0, status: 'approved', total: 3000,
      items: [
        { name: 'Flat White Old', salesItemId: oldItem._id, quantity: 40, unitPrice: 30 },
        { name: 'Flat White', salesItemId: root._id, quantity: 60, unitPrice: 30 },
      ],
    });
    const scored = (await updateForecastActuals(cafe._id, day)).toObject();
    expect(scored.accuracy).toBe(expectedAccuracy);
    expect(scored.itemAccuracy).toBe(expectedAccuracy);
    expect(scored.calibrationExcluded).toBe(true);
    expect(scored.items.map((item) => item.expectedQty)).toEqual([oldPrediction, rootPrediction]);
    expect(scored.items.map((item) => item.actualQty)).toEqual([null, 100]);
  });

  it('scores a day by item-level error as well as volume', async () => {
    const day = localDay(1);
    await Forecast.create({
      cafeId: cafe._id, date: day, generatedAt: new Date(), signals: quietSignals, totalPredictedRevenue: 0,
      items: [
        { itemName: 'Flat White', predictedQty: 100, expectedQty: 100 },
        { itemName: 'Muffin', predictedQty: 0, expectedQty: 0 },
      ],
      forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: 100, includesAllRevenue: true },
    });
    await Transaction.create({
      cafeId: cafe._id, date: at(day, 10), hour: 10, dayOfWeek: 0, status: 'approved', total: 3000,
      items: [{ name: 'Flat White', quantity: 50, unitPrice: 30 }, { name: 'Muffin', quantity: 50, unitPrice: 30 }],
    });

    const scored = (await updateForecastActuals(cafe._id, day)).toObject();

    // Units match (100 v 100) so volume accuracy is perfect; every line was wrong by 50, so item accuracy is 0.
    expect(scored.accuracy).toBe(100);
    expect(scored.itemAccuracy).toBe(0);
  });

  it('counts the unstored long tail as one aggregate term', async () => {
    const day = localDay(1);
    await Forecast.create({
      cafeId: cafe._id, date: day, generatedAt: new Date(), signals: quietSignals, totalPredictedRevenue: 0,
      items: [
        { itemName: 'Latte', predictedQty: 10, expectedQty: 10 },
        { itemName: 'Brownie', predictedQty: 5, expectedQty: 5 },
      ],
      // One more unit was forecast across lines too small to store.
      forecastCoverage: { itemCount: 3, storedItemCount: 2, totalPredictedQty: 16, includesAllRevenue: true },
    });
    await Transaction.create({
      cafeId: cafe._id, date: at(day, 10), hour: 10, dayOfWeek: 0, status: 'approved', total: 480,
      items: [
        { name: 'Latte', quantity: 6, unitPrice: 30 },
        { name: 'Brownie', quantity: 9, unitPrice: 30 },
        { name: 'Rusk', quantity: 1, unitPrice: 30 },
      ],
    });

    const scored = (await updateForecastActuals(cafe._id, day)).toObject();

    // Volume: 16 forecast, 16 sold = 100. Items: |10-6| + |5-9| + |(16-15) - (16-15)| = 8 of 16 sold = 50.
    expect(scored.accuracy).toBe(100);
    expect(scored.itemAccuracy).toBe(50);
  });

  it('returns item-level accuracy beside the headline', async () => {
    for (let d = 1; d <= 5; d += 1) await scoredDay(cafe._id, d, { accuracy: 90, itemAccuracy: 60 });

    const res = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);

    expect(res.body).toEqual(expect.objectContaining({ avgAccuracy: 90, avgItemAccuracy: 60, itemAccuracyDays: 5 }));
  });

  it('labels a backtest headline as scored with observed weather, and only a backtest one', async () => {
    for (let d = 1; d <= 10; d += 1) await scoredDay(cafe._id, d, { origin: 'backfill', accuracy: 80 });
    const backtest = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);
    expect(backtest.body.basis).toBe('backtest');
    expect(backtest.body.basisNote).toBe(BACKTEST_BASIS_NOTE);
    expect(BACKTEST_BASIS_NOTE).toMatch(/weather that actually happened/);

    for (let d = 11; d <= 15; d += 1) await scoredDay(cafe._id, d, { accuracy: 90 });
    const live = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);
    expect(live.body.basis).toBe('live');
    expect(live.body.basisNote).toBeNull();
  });

  it('keeps insufficient_data days out of the History summaries and says so', async () => {
    await Forecast.create({
      cafeId: cafe._id, date: localDay(2), generatedAt: new Date(), origin: 'live', signals: quietSignals,
      availability: { status: 'ready' }, items: [], totalPredictedRevenue: 100,
    });
    await Forecast.create({
      cafeId: cafe._id, date: localDay(3), generatedAt: new Date(), origin: 'live', signals: quietSignals,
      availability: { status: 'insufficient_data', reason: 'At least 3 observed matching trading days are required; 0 available' },
      items: [], totalPredictedRevenue: 0,
    });
    for (const d of [2, 3]) {
      await Transaction.create({
        cafeId: cafe._id, date: at(localDay(d), 10), hour: 10, dayOfWeek: 0, status: 'approved', total: 100,
        items: [{ name: 'Flat White', quantity: 1, unitPrice: 100 }],
      });
    }

    const res = await request.get('/api/forecasts/history?days=7&backfill=false').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(2);
    const building = res.body.history.find((row) => row.dateKey === zonedDateKey(localDay(3), TZ));
    expect(building).toEqual(expect.objectContaining({ availabilityStatus: 'insufficient_data', countsTowardAccuracy: false }));
    // Counting the disowned R0 day would average 100% and 0% into 50%.
    expect(res.body.meta.liveAccuracy).toEqual(expect.objectContaining({
      rowCount: 1, excludedRowCount: 1, avgDailyRevenueAccuracy: 100,
    }));
  });

    it('marks History backtest accuracy as scored with observed weather', async () => {
    const day = localDay(2);
    await scoredDay(cafe._id, 2, { origin: 'backfill', accuracy: 80 });
    await Transaction.create({
      cafeId: cafe._id, date: at(day, 10), hour: 10, dayOfWeek: 0, status: 'approved', total: 100,
      items: [{ name: 'Flat White', quantity: 3, unitPrice: 33 }],
    });

    const res = await request.get('/api/forecasts/history?days=7&backfill=false').set('Authorization', `Bearer ${token}`);

    expect(res.body.meta.backtestAccuracy).toEqual(expect.objectContaining({ rowCount: 1, note: BACKTEST_BASIS_NOTE }));
      expect(res.body.meta.liveAccuracy.note ?? null).toBeNull();
    });

    it('falls back to backtests after excluding insufficient live days, while counting closed days', async () => {
      for (let d = 1; d <= 4; d += 1) await scoredDay(cafe._id, d);
      await scoredDay(cafe._id, 5, { status: 'insufficient_data' });
      await scoredDay(cafe._id, 6, { origin: 'backfill', accuracy: 70, itemAccuracy: 55 });
      const backtest = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);
      expect(backtest.status).toBe(200);
      expect(backtest.body).toEqual(expect.objectContaining({
        basis: 'backtest', liveCount: 4, backtestCount: 1, excludedInsufficientDays: 1, avgItemAccuracy: 55,
      }));
      await scoredDay(cafe._id, 7, { status: 'closed', accuracy: 0, itemAccuracy: 0 });
      const live = await request.get('/api/forecasts/accuracy').set('Authorization', `Bearer ${token}`);
      expect(live.status).toBe(200);
      expect(live.body).toEqual(expect.objectContaining({ basis: 'live', liveCount: 5, avgAccuracy: 72, avgItemAccuracy: 0 }));
      expect(live.body.forecasts).toHaveLength(5);
    });

    it('clears old item accuracy when a completed day has no transactions', async () => {
      const day = await scoredDay(cafe._id, 1, { itemAccuracy: 80 });
      const scored = await updateForecastActuals(cafe._id, day.date);
      expect(scored.itemAccuracy).toBeUndefined();
      expect((await Forecast.findById(day._id).lean()).itemAccuracy).toBeUndefined();
    });
  });

describe('item accuracy boundaries', () => {
  const { _test: { itemWape } } = require('../../src/services/forecast.service');
  it('uses volume error when no stored lines exist', () => {
    expect(itemWape([], { totalPredicted: 80, totalActual: 100 })).toBeCloseTo(80);
  });
  it('clamps a negative predicted tail and reads legacy rounded predictions', () => {
    expect(itemWape([{ predictedQty: 10, actualQty: 10 }], { totalPredicted: 5, totalActual: 10 })).toBe(100);
  });
  it('skips unscorable lines and returns null when nothing sold', () => {
    expect(itemWape([{ expectedQty: 10, actualQty: null }], { totalPredicted: 10, totalActual: 10 })).toBe(100);
    expect(itemWape([], { totalPredicted: 10, totalActual: 0 })).toBeNull();
  });
});
