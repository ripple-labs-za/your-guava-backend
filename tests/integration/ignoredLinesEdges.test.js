// BE-03-T11 review focus: un-ignoring brings a line back, legacy lines with no status count, forecasts made before the
// ignore are re-scored against what they predicted, and a basket with an ignored line still pairs its real items.
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');
const Forecast = require('../../src/models/Forecast.model');
const { clearApiCache } = require('../../src/middleware/cache.middleware');
const { addZonedDays, zonedDayStart, zonedDayOfWeek, zonedDateKey } = require('../../src/services/parser.service');
const { generateForecast, updateForecastActuals } = require('../../src/services/forecast.service');
const { isDemandLine, demandLines } = require('../../src/utils/demand');
const { relinkIgnoredLines } = require('../../src/migrations/relink-ignored-lines');

const createdOrgIds = [];
const createCacheTestUser = async (...args) => {
  const owner = await createTestUser(...args);
  createdOrgIds.push(owner.user.orgId);
  return owner;
};
const clearTestCaches = () => createdOrgIds.forEach((orgId) => clearApiCache({ orgId }));

const request = supertest(app);
const ZONE = 'Africa/Johannesburg';

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  clearTestCaches();
  await clearDB();
  createdOrgIds.length = 0;
});

const nineAm = (daysAgo) => {
  const day = addZonedDays(zonedDayStart(new Date(), ZONE), -daysAgo, ZONE);
  return new Date(day.getTime() + 9 * 3600 * 1000);
};
const get = (token, url) => request.get(url).set('Authorization', `Bearer ${token}`);
const resolve = (token, id, body) => request.post(`/api/items/${id}/resolve`).set('Authorization', `Bearer ${token}`).send(body);
const range = () => `startDate=${zonedDateKey(nineAm(35), ZONE)}&endDate=${zonedDateKey(new Date(), ZONE)}`;

// Latte, Delivery Fee and (optionally) Muffin on the same receipts for four weeks and the last two days; nothing ignored yet.
const seed = async ({ withMuffin = false } = {}) => {
  const owner = await createCacheTestUser();
  const cafeId = owner.user.activeCafeId;
  const latte = await Item.create({ cafeId, name: 'Latte', normalizedName: 'latte', category: 'coffee', reviewStatus: 'matched', expectedPrice: 38 });
  const fee = await Item.create({ cafeId, name: 'Delivery Fee', normalizedName: 'delivery fee', reviewStatus: 'needs_review', expectedPrice: 10 });
  const muffin = await Item.create({ cafeId, name: 'Muffin', normalizedName: 'muffin', category: 'food', reviewStatus: 'matched', expectedPrice: 30 });
  await Transaction.create([7, 14, 21, 28, 1, 2].map((daysAgo, index) => {
    const date = nineAm(daysAgo);
    return {
      cafeId, receiptId: `EDGE-${index}`, date, hour: 9, dayOfWeek: zonedDayOfWeek(date, ZONE), status: 'approved', total: withMuffin ? 78 : 48,
      items: [
        { salesItemId: latte._id, name: 'Latte', quantity: 1, unitPrice: 38, priceSource: 'exact', menuItemStatus: 'matched' },
        { salesItemId: fee._id, name: 'Delivery Fee', quantity: 1, unitPrice: 10, priceSource: 'exact', menuItemStatus: 'needs_review' },
        ...(withMuffin ? [{ salesItemId: muffin._id, name: 'Muffin', quantity: 1, unitPrice: 30, priceSource: 'exact', menuItemStatus: 'matched' }] : []),
      ],
    };
  }));
  return { ...owner, cafeId, fee };
};

describe('ignored lines at the edges', () => {
  it('brings the line back everywhere when the owner un-ignores it', async () => {
    const { token, cafeId, fee } = await seed();
    await resolve(token, fee._id, { action: 'ignore' });
    clearTestCaches();
    expect((await get(token, `/api/analytics/items?${range()}`)).body.items.map((item) => item.name)).toEqual(['Latte']);

    const confirmed = await resolve(token, fee._id, { action: 'confirm' });
    clearTestCaches();

    expect(confirmed.status).toBe(200);
    const lines = (await Transaction.find({ cafeId }).lean()).flatMap((tx) => tx.items).filter((item) => item.name === 'Delivery Fee');
    expect(lines.every((item) => item.menuItemStatus === 'matched')).toBe(true);
    expect((await get(token, `/api/analytics/items?${range()}`)).body.items.map((item) => item.name).sort()).toEqual(['Delivery Fee', 'Latte']);
    const forecast = await generateForecast(cafeId, zonedDayStart(new Date(), ZONE));
    expect(forecast.items.map((item) => item.itemName)).toContain('Delivery Fee');
  });

  it('counts legacy lines that carry no status as demand, in the helpers and in the pipelines', async () => {
    expect(isDemandLine({ name: 'Latte' })).toBe(true);
    expect(isDemandLine({ name: 'Fee', menuItemStatus: 'ignored' })).toBe(false);
    expect(demandLines(undefined)).toEqual([]);
    const owner = await createCacheTestUser();
    await Transaction.create({
      cafeId: owner.user.activeCafeId, receiptId: 'OLD-1', date: nineAm(1), hour: 9, status: 'approved', total: 38,
      items: [{ name: 'Old Latte', quantity: 2, unitPrice: 19 }],
    });
    // The schema defaults menuItemStatus, so the field is removed on disk to make the line truly legacy (review).
    await Transaction.collection.updateOne({ receiptId: 'OLD-1' }, { $unset: { 'items.0.menuItemStatus': '' } });
    const raw = await Transaction.collection.findOne({ receiptId: 'OLD-1' });
    expect(raw.items[0]).not.toHaveProperty('menuItemStatus');
    const stats = await get(owner.token, '/api/transactions/stats');
    expect(stats.body.stats.topItems.map((item) => item.name)).toEqual(['Old Latte']);
  });

  it('re-scores a forecast made before the ignore against the fee it predicted, and one without it without', async () => {
    const { token, cafeId, fee } = await seed();
    const scored = { actualsUpdatedAt: new Date(), totalPredictedRevenue: 48 };
    const withFee = await Forecast.create({ cafeId, date: zonedDayStart(nineAm(2), ZONE), ...scored,
      items: [{ itemName: 'Latte', predictedQty: 1 }, { itemName: 'Delivery Fee', predictedQty: 1 }] });
    const withoutFee = await Forecast.create({ cafeId, date: zonedDayStart(nineAm(1), ZONE), ...scored,
      items: [{ itemName: 'Latte', predictedQty: 1 }] });

    await resolve(token, fee._id, { action: 'ignore' }); // re-scores history inline under NODE_ENV=test

    const before = await Forecast.findById(withFee._id).lean();
    const after = await Forecast.findById(withoutFee._id).lean();
    expect(before.items.find((item) => item.itemName === 'Delivery Fee').actualQty).toBe(1);
    expect(before.accuracy).toBe(100);
    expect(after.accuracy).toBe(100);
  });

  // Review of BE-03-T11: R3 read the predicted names off the 25 stored items, so an ignored line the forecast predicted
  // further down its list was dropped from the actuals and accuracy fell.
  it('keeps an ignored line the forecast predicted beyond its stored items in the actuals', async () => {
    const { token, cafeId, fee } = await seed();
    await resolve(token, fee._id, { action: 'ignore' });
    const day = zonedDayStart(nineAm(1), ZONE);
    await Forecast.create({
      cafeId, date: day, totalPredictedRevenue: 48, items: [{ itemName: 'Latte', predictedQty: 1 }],
      forecastCoverage: { itemCount: 2, storedItemCount: 1, totalPredictedQty: 2, includesAllRevenue: true, predictedItemNames: ['Latte', 'Delivery Fee'] },
    });

    const scored = await updateForecastActuals(cafeId, day, { timezone: ZONE });

    expect(scored.accuracy).toBe(100);
  });

  it('records every predicted name at generation, outside the API payload', async () => {
    const { cafeId } = await seed();
    const forecast = await generateForecast(cafeId, zonedDayStart(new Date(), ZONE));
    const stored = await Forecast.findById(forecast._id).select('+forecastCoverage.predictedItemNames').lean();
    expect(stored.forecastCoverage.predictedItemNames.sort()).toEqual(['Delivery Fee', 'Latte']);
    expect((await Forecast.findById(forecast._id).lean()).forecastCoverage).not.toHaveProperty('predictedItemNames');
  });

  // Review of BE-03-T11: lines the old writer stored as price_mismatch for an already ignored item keep counting until
  // they are relinked; nothing makes the owner act on that item again.
  it('marks an ignored item\'s old price_mismatch lines ignored through the migration', async () => {
    const { token, cafeId, fee } = await seed();
    await resolve(token, fee._id, { action: 'ignore' });
    await Transaction.create({
      cafeId, receiptId: 'MIS-1', date: nineAm(1), hour: 9, status: 'approved', total: 25,
      items: [{ salesItemId: fee._id, name: 'Delivery Fee', quantity: 3, unitPrice: 25, priceSource: 'exact', menuItemStatus: 'price_mismatch' }],
    });
    clearTestCaches();
    expect((await get(token, '/api/transactions/stats')).body.stats.topItems.map((item) => item.name)).toContain('Delivery Fee');

    const report = await relinkIgnoredLines();
    const applied = await relinkIgnoredLines({ apply: true });
    clearTestCaches();

    expect(report).toMatchObject({ ignoredItems: 1, transactionsWithMislabelledLines: 1, applied: false });
    expect(applied.transactionsWithMislabelledLines).toBe(1);
    expect((await Transaction.findOne({ cafeId, receiptId: 'MIS-1' }).lean()).items[0].menuItemStatus).toBe('ignored');
    expect((await get(token, '/api/transactions/stats')).body.stats.topItems.map((item) => item.name)).toEqual(['Latte']);
    expect((await relinkIgnoredLines()).transactionsWithMislabelledLines).toBe(0);
  });

  it('still pairs Latte and Muffin in a basket that also carries an ignored fee', async () => {
    const { token, fee } = await seed({ withMuffin: true });
    await resolve(token, fee._id, { action: 'ignore' });
    clearTestCaches();
    const res = await get(token, `/api/analytics/combos?${range()}`);
    expect(res.body.data).toEqual([expect.objectContaining({ pair: ['Latte', 'Muffin'], count: 6 })]);
  });
});
