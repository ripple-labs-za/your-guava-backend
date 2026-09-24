jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const { clearApiCache } = require('../../src/middleware/cache.middleware');
const { addZonedDays, zonedDayStart, zonedDayOfWeek, zonedDateKey } = require('../../src/services/parser.service');
const { generateForecast, updateForecastActuals, _test: forecastInternals } = require('../../src/services/forecast.service');
const { buildBusinessContext, buildSummaryStats } = require('../../src/services/anthropic.service');
const { reconcileTransactionItems } = require('../../src/services/menuItems.service');

const request = supertest(app);
const ZONE = 'Africa/Johannesburg';

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  clearApiCache();
  jest.restoreAllMocks();
  delete process.env.ACCOUNTING_INTEGRATIONS_ENABLED;
  await clearDB();
});

const nineAm = (daysAgo) => {
  const day = addZonedDays(zonedDayStart(new Date(), ZONE), -daysAgo, ZONE);
  return new Date(day.getTime() + 9 * 3600 * 1000);
};

/**
 * Latte and Delivery Fee sold together on the same weekday for four weeks, plus yesterday and two days ago,
 * then the owner ignores Delivery Fee through the real API — the flow gap-1 describes.
 */
const seedAndIgnore = async () => {
  const owner = await createTestUser();
  const cafeId = owner.user.activeCafeId;
  const latte = await Item.create({ cafeId, name: 'Latte', normalizedName: 'latte', category: 'coffee', reviewStatus: 'matched', expectedPrice: 38 });
  const fee = await Item.create({ cafeId, name: 'Delivery Fee', normalizedName: 'delivery fee', reviewStatus: 'needs_review', expectedPrice: 10 });
  const days = [7, 14, 21, 28, 1, 2];
  await Transaction.create(days.map((daysAgo, index) => {
    const date = nineAm(daysAgo);
    return {
      cafeId, receiptId: `IGN-${index}`, date, hour: 9, dayOfWeek: zonedDayOfWeek(date, ZONE), status: 'approved', total: 48,
      items: [
        { salesItemId: latte._id, name: 'Latte', quantity: 1, unitPrice: 38, priceSource: 'exact', menuItemStatus: 'matched' },
        { salesItemId: fee._id, name: 'Delivery Fee', quantity: 1, unitPrice: 10, priceSource: 'exact', menuItemStatus: 'needs_review' },
      ],
    };
  }));
  const ignored = await request.post(`/api/items/${fee._id}/resolve`).set('Authorization', `Bearer ${owner.token}`).send({ action: 'ignore' });
  expect(ignored.status).toBe(200);
  clearApiCache();
  return { ...owner, cafeId, orgId: owner.user.orgId, latte, fee };
};

const get = (token, url) => request.get(url).set('Authorization', `Bearer ${token}`);
const range = () => `startDate=${zonedDateKey(nineAm(35), ZONE)}&endDate=${zonedDateKey(new Date(), ZONE)}`;

describe('after the owner ignores a POS line, demand never counts it', () => {
  it('R1 regenerated forecast does not predict it', async () => {
    const { cafeId } = await seedAndIgnore();
    const forecast = await generateForecast(cafeId, zonedDayStart(new Date(), ZONE));
    const names = forecast.items.map((item) => item.itemName);
    expect(names).toContain('Latte');
    expect(names).not.toContain('Delivery Fee');
  });

  it('R2 historical price map leaves it out', async () => {
    const { cafeId } = await seedAndIgnore();
    const transactions = await Transaction.find({ cafeId }).lean();
    const prices = forecastInternals.buildHistoricalPriceMap(transactions);
    expect(prices.has('Latte')).toBe(true);
    expect(prices.has('Delivery Fee')).toBe(false);
  });

  it('R3 actuals leave it out of a forecast that did not predict it, and keep it for one that did', async () => {
    const { cafeId } = await seedAndIgnore();
    const yesterday = zonedDayStart(nineAm(1), ZONE);
    const twoDaysAgo = zonedDayStart(nineAm(2), ZONE);
    await Forecast.create({ cafeId, date: yesterday, items: [{ itemName: 'Latte', predictedQty: 1 }], totalPredictedRevenue: 38 });
    await Forecast.create({ cafeId, date: twoDaysAgo, items: [{ itemName: 'Latte', predictedQty: 1 }, { itemName: 'Delivery Fee', predictedQty: 1 }], totalPredictedRevenue: 48 });

    const after = (await updateForecastActuals(cafeId, yesterday, { timezone: ZONE })).toObject();
    expect(after.accuracy).toBe(100);
    const before = (await updateForecastActuals(cafeId, twoDaysAgo, { timezone: ZONE })).toObject();
    expect(before.items.find((item) => item.itemName === 'Delivery Fee').actualQty).toBe(1);
    expect(before.accuracy).toBe(100);
  });

  it('R4/R5 Performance items and movers leave it out', async () => {
    const { token } = await seedAndIgnore();
    const res = await get(token, `/api/analytics/items?${range()}`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.name)).toEqual(['Latte']);
    const movers = [...res.body.meta.risingItems, ...res.body.meta.decliningItems].map((item) => item.name);
    expect(movers).not.toContain('Delivery Fee');
  });

  it('R6 items per transaction counts only demand lines', async () => {
    const { token } = await seedAndIgnore();
    const res = await get(token, `/api/analytics/customers?${range()}`);
    expect(res.body.insights.avgItemsPerTransaction).toBe(1);
  });

  it('R7 combos never pair it', async () => {
    const { token } = await seedAndIgnore();
    const res = await get(token, `/api/analytics/combos?${range()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('R8 the combos fallback never pairs it either', async () => {
    const { token } = await seedAndIgnore();
    const aggregate = Transaction.aggregate.bind(Transaction);
    jest.spyOn(Transaction, 'aggregate').mockImplementationOnce(() => { throw new Error('$sortArray is not supported'); })
      .mockImplementation(aggregate);
    const res = await get(token, `/api/analytics/combos?${range()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('R9 Today top items leave it out', async () => {
    const { token } = await seedAndIgnore();
    const res = await get(token, '/api/transactions/stats');
    expect(res.body.stats.topItems.map((item) => item.name)).toEqual(['Latte']);
  });

  it('R10 the Generate insights summary leaves it out', async () => {
    const { cafeId } = await seedAndIgnore();
    const summary = buildSummaryStats(await Transaction.find({ cafeId }).lean(), ZONE);
    expect(summary.topItems.map((item) => item.name)).toEqual(['Latte']);
  });

  it('R11 Ask Guava top items leave it out', async () => {
    const { cafeId, orgId } = await seedAndIgnore();
    const context = await buildBusinessContext({ cafeId, orgId, authorizedCafeIds: [cafeId] });
    expect(context.topItems90d.map((item) => item.name)).toEqual(['Latte']);
  });

  it('R12 Ask Guava recent transactions leave it out', async () => {
    const { cafeId, orgId } = await seedAndIgnore();
    const context = await buildBusinessContext({ cafeId, orgId, authorizedCafeIds: [cafeId] });
    expect(context.recentTransactions.flatMap((tx) => tx.items.map((item) => item.name))).not.toContain('Delivery Fee');
    expect(context.recentTransactions[0].total).toBe(48); // takings are unchanged
  });

  it('R13 the accounting sync does not book it as an item sale', async () => {
    const { token, cafeId } = await seedAndIgnore();
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    await Cafe.findByIdAndUpdate(cafeId, { $set: {
      'accountingIntegrations.xero.connected': true,
      'accountingIntegrations.xero.accessToken': 'plain-access-token',
      'accountingIntegrations.xero.refreshToken': 'plain-refresh-token',
      'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600 * 1000),
    } });
    const res = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);
    expect(res.body.summary.itemBreakdown).toHaveProperty('Latte');
    expect(res.body.summary.itemBreakdown).not.toHaveProperty('Delivery Fee');
  });

  it('W1 a later import of the ignored line stays ignored even at a different price', async () => {
    const { cafeId } = await seedAndIgnore();
    const [line] = await reconcileTransactionItems(cafeId, [{ name: 'Delivery Fee', quantity: 1, unitPrice: 25, priceSource: 'exact' }]);
    expect(line.menuItemStatus).toBe('ignored');
  });

  it('keeps the ignored item\'s own sold count so it can be un-ignored', async () => {
    const { cafeId, fee } = await seedAndIgnore();
    expect(await Item.findById(fee._id).lean()).toMatchObject({ reviewStatus: 'ignored', isActive: false, totalSold: 6 });
    const lines = (await Transaction.find({ cafeId }).lean()).flatMap((tx) => tx.items).filter((item) => item.name === 'Delivery Fee');
    expect(lines.every((item) => item.menuItemStatus === 'ignored')).toBe(true);
  });
});
