const mockClearApiCache = jest.fn();
jest.mock('../../src/middleware/cache.middleware', () => {
  const actual = jest.requireActual('../../src/middleware/cache.middleware');
  return { ...actual, clearApiCache: (...args) => mockClearApiCache(...args) };
});
jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const { setup, teardown, clearDB } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const GeneratedInsight = require('../../src/models/GeneratedInsight.model');
const Transaction = require('../../src/models/Transaction.model');
const { encryptSecret } = require('../../src/services/secrets.service');
const { syncOrders, processWebhookEvent } = require('../../src/services/yoco.service');

let consoleSpies;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  process.env.YOCO_API_URL = 'https://api.yoco.invalid';
  mockClearApiCache.mockReset();
  axios.get.mockReset();
  consoleSpies = ['warn', 'log'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(async () => {
  consoleSpies.forEach((spy) => spy.mockRestore());
  jest.restoreAllMocks();
  await clearDB();
});

const order = (overrides = {}) => ({
  id: 'order-1',
  created_at: '2026-04-01T22:30:00Z',
  line_items: [{ item_type: 'product', name: 'Flat White', quantity: 1, unit_price: { amount: 3800 } }],
  amounts: { gross_amount: { amount: 3800 } },
  payments: [{ payment_method: 'card' }],
  ...overrides,
});

const connectedCafe = (overrides = {}) => Cafe.create({
  name: 'Webhook Cafe',
  orgId: new mongoose.Types.ObjectId(),
  yocoConnected: true,
  yocoTokens: {
    accessToken: encryptSecret('access-1'),
    refreshToken: encryptSecret('refresh-1'),
    expiresAt: new Date(Date.now() + 3600 * 1000),
  },
  ...overrides,
});

describe('synced transactions use the cafe clock', () => {
  it.each([
    ['2026-03-29T00:30:00Z', 0, 0],
    ['2026-03-29T01:30:00Z', 2, 0],
    ['2026-04-01T22:59:59.999Z', 23, 3],
  ])('uses the London clock at %s', async (instant, hour, dayOfWeek) => {
    const cafe = await Cafe.create({ name: 'DST Cafe', orgId: new mongoose.Types.ObjectId(), timezone: 'Europe/London' });
    await syncOrders(cafe._id, [order({ created_at: instant })]);
    expect(await Transaction.findOne({ cafeId: cafe._id }).lean()).toMatchObject({ hour, dayOfWeek });
  });

  it('refuses an invalid order date without writing a transaction', async () => {
    const cafe = await connectedCafe();
    expect(await syncOrders(cafe._id, [order({ created_at: 'not-a-date' })])).toMatchObject({ imported: 0, errors: 1 });
    expect(await Transaction.countDocuments({ cafeId: cafe._id })).toBe(0);
    expect(mockClearApiCache).not.toHaveBeenCalled();
  });
  it('takes hour and weekday from the cafe timezone, not the server', async () => {
    // 22:30Z on Wed 1 April is 23:30 Wednesday in London (BST) but 00:30 Thursday in Johannesburg.
    const cafe = await Cafe.create({ name: 'London Cafe', orgId: new mongoose.Types.ObjectId(), timezone: 'Europe/London' });

    await syncOrders(cafe._id, [order()]);

    const txn = await Transaction.findOne({ cafeId: cafe._id }).lean();
    expect(txn).toMatchObject({ hour: 23, dayOfWeek: 3 });
    expect(txn.date.toISOString()).toBe('2026-04-01T22:30:00.000Z');
  });
});

describe('a sync refreshes what was derived from the old data', () => {
  it('invalidates committed rows even if cancellation stops the rest of the sync', async () => {
    const cafe = await connectedCafe();
    const controller = new AbortController();
    const original = Transaction.findOneAndUpdate.bind(Transaction);
    jest.spyOn(Transaction, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      const row = await original(...args);
      controller.abort(new Error('sync deadline'));
      return row;
    });
    await expect(syncOrders(cafe._id, [order(), order({ id: 'second-order' })], { signal: controller.signal }))
      .rejects.toThrow('sync deadline');
    expect(await Transaction.countDocuments({ cafeId: cafe._id })).toBe(1);
    expect(mockClearApiCache).toHaveBeenCalledWith({ cafeId: String(cafe._id) });
  });

  it('keeps imported rows and clears the cache if insight invalidation fails', async () => {
    const ai = require('../../src/services/anthropic.service');
    jest.spyOn(ai, 'invalidateInsights').mockRejectedValueOnce(new Error('insight write unavailable'));
    const cafe = await connectedCafe();
    expect(await syncOrders(cafe._id, [order()])).toMatchObject({ imported: 1, errors: 0 });
    expect(await Transaction.countDocuments({ cafeId: cafe._id })).toBe(1);
    expect(mockClearApiCache).toHaveBeenCalledWith({ cafeId: String(cafe._id) });
  });
  it('invalidates insights and clears the cafe analytics cache when it imports rows', async () => {
    const cafe = await Cafe.create({ name: 'Insight Cafe', orgId: new mongoose.Types.ObjectId() });
    await GeneratedInsight.create({
      cafeId: cafe._id, orgId: cafe.orgId, insights: ['Lattes lead mornings'],
      generatedAt: new Date(Date.now() - 60 * 1000), invalidatedAt: null,
    });

    const result = await syncOrders(cafe._id, [order()]);

    expect(result.imported).toBe(1);
    const insight = await GeneratedInsight.findOne({ cafeId: cafe._id }).lean();
    expect(insight.invalidatedAt).toBeInstanceOf(Date);
    expect(mockClearApiCache).toHaveBeenCalledWith(expect.objectContaining({ cafeId: String(cafe._id) }));
  });

  it('leaves derived views alone when a sync only skips duplicates', async () => {
    const cafe = await Cafe.create({ name: 'Duplicate Cafe', orgId: new mongoose.Types.ObjectId() });
    await syncOrders(cafe._id, [order()]);
    mockClearApiCache.mockReset();

    const again = await syncOrders(cafe._id, [order()]);

    expect(again).toMatchObject({ imported: 0, skipped: 1 });
    expect(mockClearApiCache).not.toHaveBeenCalled();
  });
});

describe('webhooks route by a stored business id or not at all', () => {
  it.each([null, '', 123, { $ne: null }, [], 'x'.repeat(129), 'x'.repeat(10_000)])(
    'refuses malformed business identifiers before looking up a cafe', async (business_id) => {
      const find = jest.spyOn(Cafe, 'find');
      expect(await processWebhookEvent({ event_type: 'payment.created', order_id: 'order-bad', business_id }))
        .toMatchObject({ status: 'rejected' });
      expect(find).not.toHaveBeenCalled();
      expect(axios.get).not.toHaveBeenCalled();
    }
  );
  it('refuses a signed event without business_id and touches no cafe', async () => {
    const bystander = await connectedCafe({ name: 'Bystander Cafe' });
    axios.get.mockResolvedValue({ data: order({ id: 'order-x' }) });

    const outcome = await processWebhookEvent({ event_type: 'payment.created', order_id: 'order-x' });

    expect(outcome).toMatchObject({ status: 'rejected', reason: 'missing_business_id' });
    expect(axios.get).not.toHaveBeenCalled();
    expect(await Transaction.countDocuments({ cafeId: bystander._id })).toBe(0);
  });

  it('routes a signed event to the one connected cafe that owns the business id', async () => {
    const owner = await connectedCafe({ yocoBusinessId: 'biz-1' });
    await connectedCafe({ name: 'Other Cafe', yocoBusinessId: 'biz-2' });
    axios.get.mockResolvedValue({ data: order({ id: 'order-2' }) });

    const outcome = await processWebhookEvent({ event_type: 'payment.created', order_id: 'order-2', business_id: 'biz-1' });

    expect(outcome.status).toBe('synced');
    expect(axios.get.mock.calls[0][0]).toBe('https://api.yoco.invalid/v1/orders/order-2');
    expect(await Transaction.countDocuments({ cafeId: owner._id })).toBe(1);
  });

  it('refuses to guess when two connected cafes claim the same business id', async () => {
    const first = await connectedCafe({ yocoBusinessId: 'biz-dup' });
    const second = await connectedCafe({ name: 'Second Cafe', yocoBusinessId: 'biz-dup' });
    axios.get.mockResolvedValue({ data: order({ id: 'order-3' }) });

    const outcome = await processWebhookEvent({ event_type: 'payment.created', order_id: 'order-3', business_id: 'biz-dup' });

    expect(outcome).toMatchObject({ status: 'unrouted', matches: 2 });
    expect(await Transaction.countDocuments({ cafeId: { $in: [first._id, second._id] } })).toBe(0);
  });

  it('ignores a business id that belongs to a disconnected cafe', async () => {
    const cafe = await connectedCafe({ yocoBusinessId: 'biz-gone', yocoConnected: false });
    axios.get.mockResolvedValue({ data: order({ id: 'order-4' }) });

    const outcome = await processWebhookEvent({ event_type: 'payment.created', order_id: 'order-4', business_id: 'biz-gone' });

    expect(outcome).toMatchObject({ status: 'unrouted', matches: 0 });
    expect(await Transaction.countDocuments({ cafeId: cafe._id })).toBe(0);
  });
});
