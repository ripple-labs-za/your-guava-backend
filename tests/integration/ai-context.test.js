const mockAnthropicMessageCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockAnthropicMessageCreate } })));
const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');
const Forecast = require('../../src/models/Forecast.model');
const { buildBusinessContext } = require('../../src/services/anthropic.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => { jest.restoreAllMocks(); mockAnthropicMessageCreate.mockReset(); await clearDB(); });

const seedTwoLocations = async () => {
  const owner = await createTestUser();
  const cafeId = owner.user.activeCafeId;
  await Cafe.updateOne({ _id: cafeId }, { $set: { timezone: 'Africa/Johannesburg' } });
  const london = await Cafe.create({ name: 'London Branch', orgId: owner.user.orgId, timezone: 'Europe/London' });
  const morning = new Date(Date.now() - 2 * 86_400_000);
  morning.setUTCHours(10, 0, 0, 0);
  const late = new Date(morning); late.setUTCHours(22, 30, 0, 0);
  const sale = (location, receiptId, date, total, quantity, hour, dayOfWeek) => ({
    cafeId: location, receiptId, date, total, status: 'approved', paymentMethod: 'card', hour, dayOfWeek,
    items: [{ name: 'Flat White', quantity, unitPrice: total / quantity }],
  });
  await Transaction.create([
    sale(cafeId, 'ctx-morning', morning, 50, 2, 12, 1),
    sale(cafeId, 'ctx-late', late, 30, 1, 0, 2),
    sale(london._id, 'ctx-london', late, 40, 1, 23, 1),
    sale(cafeId, 'ctx-refund', morning, -10, -1, 12, 1),
  ]);
  const tomorrow = new Date(Date.now() + 86_400_000);
  await Forecast.create({
    cafeId, date: tomorrow, dateKey: tomorrow.toISOString().slice(0, 10), modelVersion: 'test', trainingCutoff: tomorrow,
    totalPredictedRevenue: 4200,
    items: Array.from({ length: 12 }, (_, index) => ({
      itemName: `Item ${index}`, predictedQty: 100 - index, factors: [{ key: 'dayOfWeek', label: 'Day', multiplier: 1.1 }],
    })),
  });
  return { owner, cafeId, london };
};

describe('Ask Guava business context', () => {
  it('preserves the two-location timezone, refund and forecast characterization before performance changes', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const context = await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(context.dataset).toMatchObject({ transactionCount: 3, totalRevenue: 110, avgBasket: 40 });
    expect(context.dailyRevenue90d).toHaveLength(3);
    expect(context.locationPerformance90d.map(({ transactions, revenue }) => ({ transactions, revenue })))
      .toEqual([{ transactions: 2, revenue: 70 }, { transactions: 1, revenue: 40 }]);
    expect(context.dayOfWeekPattern90d).toEqual([
      { day: 'Monday', revenue: 80, transactions: 2, avgRevenuePerTransaction: 45 },
      { day: 'Tuesday', revenue: 30, transactions: 1, avgRevenuePerTransaction: 30 },
    ]);
    expect(context.topItems90d).toEqual([{ name: 'Flat White', quantity: 3, revenue: 110 }]);
    expect(context.upcomingForecasts[0].topItems).toHaveLength(10);
    expect(JSON.stringify(context)).not.toContain('factors');
  });

  it('loads only forecast fields that become model input', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    const find = jest.spyOn(Forecast, 'find');
    await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    expect(Object.keys(find.mock.results[0].value.projection()).sort()).toEqual([
      'accuracy', 'date', 'items.itemName', 'items.predictedQty', 'signals', 'totalPredictedRevenue',
    ]);
  });

  it('never gives the owner-wide context to a manager scoped to the active cafe', async () => {
    const { owner, cafeId } = await seedTwoLocations();
    await buildBusinessContext({ cafeId, orgId: owner.user.orgId });
    const scoped = await buildBusinessContext({ cafeId, orgId: owner.user.orgId, authorizedCafeIds: [String(cafeId)] });
    expect(scoped.locations).toHaveLength(1);
    expect(scoped.dataset.transactionCount).toBe(2);
    expect(scoped.dataset.totalRevenue).toBe(70);
  });
});
