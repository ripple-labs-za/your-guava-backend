// Forecast cost guards (BE-14-T04): a week and a backfill batch read their data once, concurrent requests generate each day once,
// shared inputs give the same forecasts as single days, range scoring equals per-day scoring, and nothing zoned runs per sale.
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Forecast = require('../../src/models/Forecast.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const forecastService = require('../../src/services/forecast.service');
const generate = require('../../src/services/forecast/generate');
const { zonedDayStart, addZonedDays, zonedDateKey } = require('../../src/utils/timezone');
const { countOperations, countFormatToParts, seedTransactions } = require('../helpers/perf');

const request = supertest(app);
jest.setTimeout(180_000);
const ZONE = 'Africa/Johannesburg';
const DATA = ['transactions', 'forecasts', 'cafes', 'items', 'events'];
const READS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct']);
const SINGLE_WRITES = new Set(['findOneAndUpdate', 'updateOne', 'replaceOne', 'insertOne']);
const dataReads = (calls) => calls.filter((c) => DATA.includes(c.collectionName) && READS.has(c.method)).length;
const forecastDayWrites = (calls) => calls.filter((c) => c.collectionName === 'forecasts').reduce((sum, c) =>
  sum + (SINGLE_WRITES.has(c.method) ? 1 : ['bulkWrite', 'insertMany'].includes(c.method) ? c.params[0].length : 0), 0);
const BIG_MENU = Array.from({ length: 40 }, (_, i) => [`Item ${String(i + 1).padStart(2, '0')}`, 20 + i]);
const VOLATILE = new Set(['_id', 'createdAt', 'updatedAt', 'generatedAt', '__v', 'actualsUpdatedAt']);
const comparable = (doc) => JSON.parse(JSON.stringify(typeof doc.toObject === 'function' ? doc.toObject() : doc,
  (key, value) => (VOLATILE.has(key) ? undefined : value)));
const days = (from, count) => Array.from({ length: count }, (_, i) => addZonedDays(from, i, ZONE));
// Backfilled days are metered (BE-06-T05); a test org's trial credits must not be what stops a batch.
const fund = (orgId) => Organization.updateOne({ _id: orgId }, { $set: { 'aiCredits.bonus': 1000 } });

beforeAll(async () => {
  await setup();
  await Forecast.init();
});
afterAll(teardown);
afterEach(clearDB);

describe('forecast generation cost', () => {
  it('F1: a cold week issues the same bounded number of data reads for a 10-item and a 40-item menu', async () => {
    const small = await createTestUser();
    await seedTransactions(small.user.activeCafeId, { days: 112, perDay: 30 });
    const smallRun = await countOperations(() => forecastService.generateWeekForecast(small.user.activeCafeId));
    expect(smallRun.result).toHaveLength(7);
    await clearDB();
    const big = await createTestUser();
    await seedTransactions(big.user.activeCafeId, { days: 112, perDay: 30, menu: BIG_MENU });
    const bigRun = await countOperations(() => forecastService.generateWeekForecast(big.user.activeCafeId));
    expect(bigRun.result).toHaveLength(7);
    expect(dataReads(bigRun.calls)).toBe(dataReads(smallRun.calls));
    expect(dataReads(bigRun.calls)).toBeLessThanOrEqual(12);
  });

  it('F2: five week requests and a today request on a cold cafe generate each day once', async () => {
    const owner = await createTestUser();
    await seedTransactions(owner.user.activeCafeId, { days: 60, perDay: 20 });
    const get = (path) => request.get(path).set('Authorization', `Bearer ${owner.token}`);
    const { result: responses, calls } = await countOperations(() => Promise.all([
      ...Array.from({ length: 5 }, () => get('/api/forecasts/week')), get('/api/forecasts/today'),
    ]));
    responses.forEach((response) => expect(response.status).toBe(200));
    responses.slice(0, 5).forEach((response) => expect(response.body.forecasts).toHaveLength(7));
    expect(forecastDayWrites(calls)).toBe(7);
    expect(await Forecast.countDocuments({ cafeId: owner.user.activeCafeId })).toBe(7);
    expect(forecastService._test.inFlightGenerations()).toBe(0); // nothing left behind once every request settled
  });

  it('F3: a 14-day history backfill reads its data once: no more than a 7-day one + 2, and at most 24', async () => {
    const owner = await createTestUser();
    await fund(owner.user.orgId);
    await seedTransactions(owner.user.activeCafeId, { days: 150, perDay: 20 });
    const backfill = (limit) => request.get('/api/forecasts/history').set('Authorization', `Bearer ${owner.token}`)
      .query({ days: 60, backfill: 'sync', backfillLimit: limit });
    const seven = await countOperations(() => backfill(7));
    expect(seven.result.status).toBe(200);
    expect(seven.result.body.meta.generated).toBe(7);
    await Forecast.deleteMany({ origin: 'backfill' });
    await UsageLedger.deleteMany({ featureKey: 'history_backfill_day' }); // the metering key would otherwise replay these days
    const fourteen = await countOperations(() => backfill(14));
    expect(fourteen.result.status).toBe(200);
    expect(fourteen.result.body.meta.generated).toBe(14);
    expect(dataReads(fourteen.calls)).toBeLessThanOrEqual(dataReads(seven.calls) + 2);
    expect(dataReads(fourteen.calls)).toBeLessThanOrEqual(24);
  });

  it('F2: a failed flight releases every day so a later request can rebuild', async () => {
    const owner = await createTestUser();
    const day = zonedDayStart(new Date(), ZONE);
    const write = jest.spyOn(Forecast, 'findOneAndUpdate').mockRejectedValueOnce(new Error('write unavailable'));
    try {
      const failed = await forecastService.generateForecastsForDates(owner.user.activeCafeId, [day]);
      expect(failed.failures).toEqual([{ dateKey: expect.any(String), message: 'write unavailable' }]);
      expect(forecastService._test.inFlightGenerations()).toBe(0);
      const retry = await forecastService.generateForecastsForDates(owner.user.activeCafeId, [day]);
      expect(retry.failures).toEqual([]);
      expect(retry.forecasts).toHaveLength(1);
      expect(forecastService._test.inFlightGenerations()).toBe(0);
    } finally { write.mockRestore(); }
  });

  it('F2: a completed flight reuses the full stored document without writing again', async () => {
    const owner = await createTestUser();
    const day = zonedDayStart(new Date(), ZONE);
    await seedTransactions(owner.user.activeCafeId, { days: 30, perDay: 10 });
    const original = await forecastService.generateForecastsForDates(owner.user.activeCafeId, [day]);
    const again = await countOperations(() => forecastService.generateForecastsForDates(owner.user.activeCafeId, [day], {
      reuse: () => true,
    }));
    expect(forecastDayWrites(again.calls)).toBe(0);
    expect(comparable(again.result.forecasts[0])).toEqual(comparable(original.forecasts[0]));
    expect(again.result.forecasts[0].items.length).toBeGreaterThan(0);
  });

  it('F4: fourteen past days generated from shared inputs are stored exactly as fourteen single-day generations', async () => {
    const owner = await createTestUser();
    const cafeId = owner.user.activeCafeId;
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { plan: 'pro' } }); // learning on: calibration is exercised
    await seedTransactions(cafeId, { days: 150, perDay: 25 });
    const today = zonedDayStart(new Date(), ZONE);
    // Live forecasts scored from 90 to 21 days ago: the first target's 60-day window (80..21 days ago) holds 60 of them, the last
    // target's (67..8 days ago) holds 47, so shared inputs computed once for the first target would give the last one wrong evidence.
    const scoredDays = days(addZonedDays(today, -90, ZONE), 70);
    await forecastService.generateForecastsForDates(cafeId, scoredDays, { origin: 'live' });
    for (const day of scoredDays) await forecastService.updateForecastActuals(cafeId, day, { timezone: ZONE });
    const targets = days(addZonedDays(today, -20, ZONE), 14);
    const context = await generate.loadForecastContext(cafeId);
    const inputs = await generate.loadForecastInputs(cafeId, targets, context);
    const together = [];
    for (const day of targets) together.push(comparable(await forecastService.generateForecast(cafeId, day, { origin: 'backfill', context, inputs })));
    await Forecast.deleteMany({ cafeId, origin: 'backfill' });
    const single = [];
    for (const day of targets) single.push(comparable(await forecastService.generateForecast(cafeId, day, { origin: 'backfill' })));
    expect(single[0].calibration.sampleSize).toBeGreaterThan(0); // learning ran (see the note after this file if it is 0)
    expect(single[13].calibration.sampleSize).not.toBe(single[0].calibration.sampleSize); // the windows really differ
    expect(together).toEqual(single);
  });

  it('F5: scoring a range equals scoring each day, reads a bounded amount, clears a day without sales, never scores today', async () => {
    const owner = await createTestUser();
    const cafeId = owner.user.activeCafeId;
    await seedTransactions(cafeId, { days: 40, perDay: 20 });
    const today = zonedDayStart(new Date(), ZONE);
    const range = days(addZonedDays(today, -14, ZONE), 15); // fourteen past days and today
    await forecastService.generateForecastsForDates(cafeId, range, { origin: 'backfill' });
    await Transaction.deleteMany({ cafeId, date: { $gte: range[3], $lt: addZonedDays(range[3], 1, ZONE) } });
    const ranged = await countOperations(() => forecastService.updateForecastActualsForRange(cafeId, range[0], range.at(-1), { timezone: ZONE }));
    expect(ranged.result).toEqual({ scored: 13, cleared: 1 });
    expect(dataReads(ranged.calls)).toBeLessThanOrEqual(4);
    const actualsOf = (f) => ({ dateKey: f.dateKey, accuracy: f.accuracy, actualRevenue: f.actualRevenue,
      actualTransactionCount: f.actualTransactionCount, itemAccuracy: f.itemAccuracy, calibrationExcluded: f.calibrationExcluded,
      items: (f.items || []).map((item) => ({ itemName: item.itemName, actualQty: item.actualQty })) });
    const afterRange = (await Forecast.find({ cafeId }).sort({ date: 1 }).lean()).map(actualsOf);
    expect(afterRange.at(-1).actualRevenue).toBeUndefined(); // today is never scored
    expect(afterRange[3].accuracy).toBeUndefined();          // the day without sales is cleared, not zeroed
    for (const day of range) await forecastService.updateForecastActuals(cafeId, day, { timezone: ZONE });
    expect((await Forecast.find({ cafeId }).sort({ date: 1 }).lean()).map(actualsOf)).toEqual(afterRange);
  });

  it('F6: a week over sixteen weeks of sales runs no zoned formatting per sale', async () => {
    const owner = await createTestUser();
    expect(await seedTransactions(owner.user.activeCafeId, { days: 112, perDay: 60 })).toBe(6_720);
    const { result, calls } = await countFormatToParts(() => forecastService.generateWeekForecast(owner.user.activeCafeId));
    expect(result).toHaveLength(7);
    expect(calls).toBeLessThanOrEqual(500); // a zoned ordinal per sale is 6,720 calls or more
  });

  it('F5: monthly slices neither drop nor double-score cafe-local days across DST', async () => {
    const owner = await createTestUser();
    const cafeId = owner.user.activeCafeId;
    const zone = 'America/New_York';
    const first = zonedDayStart('2026-02-06', zone);
    const targets = Array.from({ length: 65 }, (_, index) => addZonedDays(first, index, zone));
    await Forecast.insertMany(targets.map((date) => ({ cafeId, date, dateKey: zonedDateKey(date, zone), items: [] })));
    await Transaction.insertMany(targets.map((date, index) => ({ cafeId, status: 'approved',
      date: new Date(addZonedDays(date, 1, zone).getTime() - 3600_000), total: index + 1, items: [],
    })));
    expect(await forecastService.updateForecastActualsForRange(cafeId, targets[0], targets.at(-1), { timezone: zone }))
      .toEqual({ scored: 65, cleared: 0 });
    const stored = await Forecast.find({ cafeId }).sort({ date: 1 }).lean();
    expect(stored.map((row) => row.actualRevenue)).toEqual(targets.map((_, index) => index + 1));
    expect(stored.every((row) => row.actualTransactionCount === 1)).toBe(true);
  });

  it('F5: a capped range scores the newest 366 stored forecasts and leaves the oldest untouched', async () => {
    const owner = await createTestUser();
    const cafeId = owner.user.activeCafeId;
    const last = addZonedDays(zonedDayStart(new Date(), ZONE), -1, ZONE);
    const first = addZonedDays(last, -366, ZONE);
    const targets = days(first, 367);
    await Forecast.insertMany(targets.map((date) => ({ cafeId, date, items: [], actualRevenue: 1, actualsUpdatedAt: new Date() })));
    expect(await forecastService.updateForecastActualsForRange(cafeId, first, last, { timezone: ZONE }))
      .toEqual({ scored: 0, cleared: 366, capped: true });
    const stored = await Forecast.find({ cafeId }).sort({ date: 1 }).lean();
    expect(stored[0].actualRevenue).toBe(1);
    expect(stored.slice(1).every((row) => row.actualRevenue === undefined && row.actualsUpdatedAt === undefined)).toBe(true);
  });
});
