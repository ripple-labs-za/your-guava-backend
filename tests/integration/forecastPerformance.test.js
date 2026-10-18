const mongoose = require('mongoose');
const { monitorEventLoopDelay } = require('perf_hooks');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const forecastService = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart, zonedDateKey, zonedDayOfWeek } = require('../../src/utils/timezone');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  mongoose.set('debug', false);
  await clearDB();
});

const TZ = 'Africa/Johannesburg';
const localDay = (offset) => addZonedDays(zonedDayStart(new Date(), TZ), offset, TZ);
const READ_METHODS = new Set(['find', 'findOne', 'countDocuments', 'aggregate', 'distinct']);

// Every database operation Mongoose issues while fn runs, as "collection.method".
const recordOperations = async (fn) => {
  const calls = [];
  mongoose.set('debug', (collection, method) => calls.push(`${collection}.${method}`));
  try {
    await fn();
  } finally {
    mongoose.set('debug', false);
  }
  return { calls, reads: calls.filter((call) => READ_METHODS.has(call.split('.')[1])) };
};

// 16 weeks x 7 days x 50 receipts x 3 lines, at cafe-local 07:00-16:00.
const seedBusyCafe = async (cafeId) => {
  const rows = [];
  for (let back = 1; back <= 16 * 7; back += 1) {
    const day = localDay(-back);
    for (let receipt = 0; receipt < 50; receipt += 1) {
      const hour = 7 + (receipt % 10);
      rows.push({
        cafeId, date: new Date(day.getTime() + hour * 3600 * 1000), hour, dayOfWeek: zonedDayOfWeek(day, TZ),
        status: 'approved', total: 120,
        items: [
          { name: 'Flat White', rawName: 'Flat white (L)', quantity: 1, unitPrice: 40 },
          { name: 'Muffin', rawName: 'Muffin', quantity: 1, unitPrice: 40 },
          { name: `Special ${receipt % 5}`, rawName: 'special', quantity: 1, unitPrice: 40 },
        ],
      });
    }
  }
  await Transaction.insertMany(rows);
  return rows.length;
};

describe('forecast performance', () => {
  let token;
  let user;
  let cafe;

  beforeEach(async () => {
    ({ token, user } = await createTestUser());
    cafe = await Cafe.findOne({});
  });

  it('builds a week from one projected transaction read, within budget', async () => {
    await Organization.findByIdAndUpdate(user.orgId, { plan: 'pro' });
    await Cafe.updateOne({ _id: cafe._id }, { $set: { forecastSettings: { history: { maxWeeks: 16 }, learning: { enabled: true } } } });
    expect(await seedBusyCafe(cafe._id)).toBe(5600);
    const findSpy = jest.spyOn(Transaction, 'find');
    const loop = monitorEventLoopDelay({ resolution: 10 });
    const heapBefore = process.memoryUsage().heapUsed;
    const started = process.hrtime.bigint();
    loop.enable();

    const { calls, reads } = await recordOperations(() => forecastService.generateWeekForecast(cafe._id));

    loop.disable();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1048576;
    const p99 = loop.percentile(99) / 1e6;
    console.log(`BE-06-T05 week budget: ${ms.toFixed(0)} ms, heap +${heapMb.toFixed(1)} MB, event-loop p99 ${p99.toFixed(1)} ms, reads ${reads.length}`);
    expect(calls.filter((call) => call === 'transactions.find')).toHaveLength(1);
    const projection = findSpy.mock.results[0].value.projection() || {};
    expect(Object.keys(projection)).toEqual(expect.arrayContaining(['date', 'dayOfWeek', 'items.name', 'items.quantity']));
    expect(Object.keys(projection)).not.toContain('items.rawName');
    expect(reads.length).toBeLessThanOrEqual(12);
    expect(ms).toBeLessThan(3000);
    expect(heapMb).toBeLessThan(150);
    expect(p99).toBeLessThan(250);
    expect(await Forecast.countDocuments({ cafeId: cafe._id, date: { $gte: localDay(0) } })).toBe(7);
  });

  it('serves GET /week from the same single read', async () => {
    await seedBusyCafe(cafe._id);
    const { calls, reads } = await recordOperations(async () => {
      const res = await request.get('/api/forecasts/week').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.forecasts).toHaveLength(7);
    });
    expect(calls.filter((call) => call === 'transactions.find')).toHaveLength(1);
    // Includes the auth middleware's own two lookups (users, organizations) and the controller's cafe and stored-week reads.
    expect(reads.length).toBeLessThanOrEqual(16);
  });

  it('caps the history range and reads only what a row needs', async () => {
    const findSpy = jest.spyOn(Forecast, 'find');
    const res = await request.get('/api/forecasts/history?startDate=2015-01-01&backfill=false').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.startDate).toBe(zonedDateKey(localDay(-1 - 365), TZ));
    expect(res.body.meta.rangeClamped).toBe(true);
    const historyRead = findSpy.mock.results.map((result) => result.value)
      .find((query) => query.getFilter().date && !query.getFilter().actualsUpdatedAt);
    const fields = Object.keys(historyRead.projection() || {});
    expect(fields).toContain('items.factors.key');
    expect(fields).toContain('totalPredictedRevenue');
    expect(fields).not.toContain('items');
  });

  it('meters each backfilled day once as history_backfill_day', async () => {
    for (const offset of [-2, -3]) {
      await Transaction.create({
        cafeId: cafe._id, date: new Date(localDay(offset).getTime() + 10 * 3600 * 1000), hour: 10,
        dayOfWeek: zonedDayOfWeek(localDay(offset), TZ), status: 'approved', total: 96,
        items: [{ name: 'Flat White', quantity: 3, unitPrice: 32 }],
      });
    }
    const url = '/api/forecasts/history?days=7&backfill=sync&backfillLimit=2';

    const first = await request.get(url).set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.meta.generated).toBe(2);
    expect(first.body.meta.backfill).toEqual(expect.objectContaining({ creditsPerDay: 1, creditsUsed: 2 }));
    const rows = await UsageLedger.find({ orgId: user.orgId, featureKey: 'history_backfill_day' }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'committed' && row.credits === 1)).toBe(true);
    expect((await Organization.findById(user.orgId).lean()).aiCredits.used).toBe(2);

    const again = await request.get(url).set('Authorization', `Bearer ${token}`);
    expect(again.body.meta.generated).toBe(0);
    expect(await UsageLedger.countDocuments({ orgId: user.orgId, featureKey: 'history_backfill_day' })).toBe(2);
  });

  it('answers a null settings section with a 400 and changes nothing', async () => {
    const res = await request.put('/api/forecasts/factors').set('Authorization', `Bearer ${token}`).send({ settings: { weather: null } });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: 'INVALID_FORECAST_SETTINGS', message: 'settings.weather must be an object' }));
    const stored = await Cafe.findById(cafe._id).lean();
    expect(stored.forecastSettings).toBeUndefined();
    expect(stored.forecastInputsVersion || 0).toBe(0);
  });

  it('logs every failed day and tells upload maintenance the week is partial', async () => {
    const failing = new Set([zonedDateKey(localDay(1), TZ), zonedDateKey(localDay(4), TZ)]);
    const realUpsert = Forecast.findOneAndUpdate.bind(Forecast);
    jest.spyOn(Forecast, 'findOneAndUpdate').mockImplementation((filter, update, options) => (
      failing.has(update?.$set?.dateKey) ? Promise.reject(new Error('write conflict')) : realUpsert(filter, update, options)
    ));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await forecastService.generateWeekForecast(cafe._id).catch((error) => error);

    expect(outcome.code).toBe('FORECAST_WEEK_PARTIAL');
    expect(outcome.failures.map((failure) => failure.dateKey).sort()).toEqual([...failing].sort());
    expect(outcome.forecasts).toHaveLength(5);
    expect(errors.mock.calls.filter(([message]) => String(message).includes('week day generation failed'))).toHaveLength(2);
  });

  it('limits synchronous backfill per user', () => {
    const router = require('../../src/routes/forecasts.routes');
    const history = router.stack.find((layer) => layer.route?.path === '/history');
    // cache first (so an ordinary read is still cached), then the compute limiter for backfill=sync, then the handler.
    expect(history.route.stack.map((layer) => layer.name)).toEqual(['cacheHistoryReads', 'limitBackfillCompute', 'getHistory']);
  });
// Append inside forecast performance's describe after the plan's red-first checks.
it('refunds a failed historical day instead of keeping its reserved credit', async () => {
  await Transaction.create({
    cafeId: cafe._id, date: new Date(localDay(-2).getTime() + 8 * 3600000), hour: 8,
    dayOfWeek: zonedDayOfWeek(localDay(-2), TZ), status: 'approved', total: 60,
    items: [{ name: 'Flat White', quantity: 2, unitPrice: 30 }],
  });
  jest.spyOn(Forecast, 'findOneAndUpdate').mockRejectedValue(new Error('historical write failed'));
  const response = await request.get('/api/forecasts/history?days=7&backfill=sync&backfillLimit=1')
    .set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(500);
  const rows = await UsageLedger.find({ orgId: user.orgId, featureKey: 'history_backfill_day' }).lean();
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('refunded');
  expect((await Organization.findById(user.orgId).lean()).aiCredits.used).toBe(0);
  expect(await Forecast.countDocuments({ cafeId: cafe._id })).toBe(0);
});

it('keeps a completed day charged exactly once when credits run out mid-batch', async () => {
  await Organization.findByIdAndUpdate(user.orgId, { $set: {
    'aiCredits.included': 400, 'aiCredits.used': 399, 'aiCredits.bonus': 0, 'aiCredits.bonusUsed': 0,
    'aiCredits.resetAt': new Date(Date.now() + 86400000),
  } });
  for (const offset of [-2, -3]) {
    await Transaction.create({
      cafeId: cafe._id, date: new Date(localDay(offset).getTime() + 8 * 3600000), hour: 8,
      dayOfWeek: zonedDayOfWeek(localDay(offset), TZ), status: 'approved', total: 60,
      items: [{ name: 'Flat White', quantity: 2, unitPrice: 30 }],
    });
  }
  const url = '/api/forecasts/history?days=7&backfill=sync&backfillLimit=2';
  const response = await request.get(url).set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(402);
  expect(await Forecast.countDocuments({ cafeId: cafe._id })).toBe(1);
  expect(await UsageLedger.countDocuments({ orgId: user.orgId, status: 'committed' })).toBe(1);
  expect((await Organization.findById(user.orgId).lean()).aiCredits.used).toBe(400);
  expect((await request.get(url).set('Authorization', `Bearer ${token}`)).status).toBe(402);
  expect(await UsageLedger.countDocuments({ orgId: user.orgId, status: 'committed' })).toBe(1);
});

it('keeps partial current-day sales out of a future-only shared history read', async () => {
  const target = localDay(7);
  for (const [offset, quantity] of [[-7, 2], [-14, 2], [0, 1000]]) {
    await Transaction.create({
      cafeId: cafe._id, date: new Date(localDay(offset).getTime() + 8 * 3600000), hour: 8,
      dayOfWeek: zonedDayOfWeek(localDay(offset), TZ), status: 'approved', total: quantity * 30,
      items: [{ name: 'Flat White', quantity, unitPrice: 30 }],
    });
  }
  const { forecasts } = await forecastService.generateForecastsForDates(cafe._id, [target]);
  expect(forecasts).toHaveLength(1);
  expect(forecasts[0].trainingData.transactionCount).toBe(2);
  expect(forecasts[0].items[0].baseQty).toBeLessThan(3);
});

it('keeps ignored POS lines out of demand after projecting the shared history', async () => {
  for (const offset of [-7, -14]) {
    await Transaction.create({
      cafeId: cafe._id, date: new Date(localDay(offset).getTime() + 8 * 3600000), hour: 8,
      dayOfWeek: zonedDayOfWeek(localDay(offset), TZ), status: 'approved', total: 150,
      items: [
        { name: 'Flat White', quantity: 2, unitPrice: 30 },
        { name: 'Delivery fee', quantity: 99, unitPrice: 1, menuItemStatus: 'ignored' },
      ],
    });
  }
  const forecasts = await forecastService.generateWeekForecast(cafe._id);
  const today = forecasts.find((forecast) => forecast.dateKey === zonedDateKey(localDay(0), TZ));
  expect(today.items.map((item) => item.itemName)).toEqual(['Flat White']);
  expect(today.forecastCoverage.totalPredictedQty).toBeLessThan(10);
});

it('refuses charged history building without the manager spending permission', async () => {
  const User = require('../../src/models/User.model');
  const jwt = require('jsonwebtoken');
  const manager = await User.create({
    name: 'History Reader', email: 'history-reader@example.test', password: 'password123',
    role: 'manager', orgId: user.orgId, cafeIds: [cafe._id], activeCafeId: cafe._id,
  });
  const managerToken = jwt.sign({ id: String(manager._id), orgId: String(user.orgId),
    cafeId: String(cafe._id), role: 'manager', tokenVersion: 0 }, process.env.JWT_SECRET);
  const read = await request.get('/api/forecasts/history').set('Authorization', `Bearer ${managerToken}`);
  expect(read.status).toBe(200);
  const build = await request.get('/api/forecasts/history?backfill=sync').set('Authorization', `Bearer ${managerToken}`);
  expect(build.status).toBe(403);
  expect(await UsageLedger.countDocuments({ orgId: user.orgId })).toBe(0);
});

it('charges only the user who builds a shared historical day during a race', async () => {
  const User = require('../../src/models/User.model');
  const jwt = require('jsonwebtoken');
  const other = await User.create({
    name: 'Second Owner', email: 'second-history@example.test', password: 'password123',
    role: 'owner', orgId: user.orgId, cafeIds: [cafe._id], activeCafeId: cafe._id,
  });
  const otherToken = jwt.sign({ id: String(other._id), orgId: String(user.orgId),
    cafeId: String(cafe._id), role: 'owner', tokenVersion: 0 }, process.env.JWT_SECRET);
  await Transaction.create({
    cafeId: cafe._id, date: new Date(localDay(-2).getTime() + 8 * 3600000), hour: 8,
    dayOfWeek: zonedDayOfWeek(localDay(-2), TZ), status: 'approved', total: 60,
    items: [{ name: 'Flat White', quantity: 2, unitPrice: 30 }],
  });
  let release;
  const bothReads = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const find = Forecast.find.bind(Forecast);
  jest.spyOn(Forecast, 'find').mockImplementation((...args) => {
    const query = find(...args);
    if (!args[0]?.date || args[0]?.actualsUpdatedAt) return query;
    const lean = query.lean.bind(query);
    query.lean = async () => {
      const rows = await lean();
      reads += 1;
      if (reads === 2) release();
      await bothReads;
      return rows;
    };
    return query;
  });
  const url = '/api/forecasts/history?days=7&backfill=sync&backfillLimit=1';
  const results = await Promise.all([token, otherToken].map((accessToken) =>
    request.get(url).set('Authorization', `Bearer ${accessToken}`)));
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  expect(await UsageLedger.countDocuments({ orgId: user.orgId, featureKey: 'history_backfill_day', status: 'committed' })).toBe(1);
  expect((await Organization.findById(user.orgId).lean()).aiCredits.used).toBe(1);
  expect(results.map((result) => result.body.meta.backfill.creditsUsed).sort()).toEqual([0, 1]);
});

});
