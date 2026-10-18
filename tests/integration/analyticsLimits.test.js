const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);
const WINDOW = { startDate: '2026-01-12', endDate: '2026-01-31' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  delete process.env.ANALYTICS_MAX_RANGE_DAYS;
  delete process.env.COMBOS_MAX_BASKETS;
  jest.restoreAllMocks();
  await clearDB();
});

const basket = (cafeId, date, names) => ({
  cafeId,
  date,
  hour: 8,
  dayOfWeek: date.getUTCDay(),
  status: 'approved',
  items: names.map((name) => ({ name, quantity: 1, unitPrice: 40 })),
  total: 40 * names.length,
});

describe('analytics limits', () => {
  let token;
  let cafeId;

  beforeEach(async () => {
    const owner = await createTestUser();
    token = owner.token;
    cafeId = owner.user.activeCafeId;
  });

  const get = (path, query) => request.get(`/api/analytics/${path}`).set('Authorization', `Bearer ${token}`).query(query);

  it('refuses a range longer than 400 days by default, with a code the portal can act on', async () => {
    const tooLong = await get('customers', { startDate: '2025-01-01', endDate: '2026-02-05' }); // 401 days
    const longest = await get('customers', { startDate: '2025-01-02', endDate: '2026-02-05' }); // 400 days

    expect(tooLong.status).toBe(400);
    expect(tooLong.body.details).toEqual({ code: 'ANALYTICS_RANGE_TOO_LONG', maxDays: 400 });
    expect(longest.status).toBe(200);
  });

  it('takes the range cap from ANALYTICS_MAX_RANGE_DAYS', async () => {
    process.env.ANALYTICS_MAX_RANGE_DAYS = '30';

    const res = await get('revenue', { startDate: '2026-01-01', endDate: '2026-01-31' }); // 31 days

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ code: 'ANALYTICS_RANGE_TOO_LONG', maxDays: 30 });
  });

  it('answers combos from the most recent baskets, flagged, instead of failing, when over the basket budget', async () => {
    process.env.COMBOS_MAX_BASKETS = '10';
    // 50 baskets an hour apart; the 10 most recent pair Flat White with Muffin, the 40 older with Brownie.
    const docs = Array.from({ length: 50 }, (_, i) => basket(
      cafeId,
      new Date(Date.UTC(2026, 0, 12, 6, 0) + i * 60 * 60 * 1000),
      ['Flat White', i < 40 ? 'Brownie' : 'Muffin'],
    ));
    await Transaction.insertMany(docs);

    const res = await get('combos', WINDOW);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ pair: ['Flat White', 'Muffin'], count: 10 }]);
    expect(res.body.meta).toEqual(expect.objectContaining({
      truncated: true, basketsConsidered: 10, maxBaskets: 10, maxItemsPerBasket: 20,
    }));
  });

  it('says combos are complete when every basket fitted', async () => {
    await Transaction.insertMany([0, 1, 2].map((i) => basket(
      cafeId, new Date(Date.UTC(2026, 0, 13, 7 + i)), ['Flat White', 'Brownie'],
    )));

    const res = await get('combos', WINDOW);

    expect(res.body.data).toEqual([{ pair: ['Brownie', 'Flat White'], count: 3 }]);
    expect(res.body.meta).toEqual(expect.objectContaining({ truncated: false, basketsConsidered: 3 }));
  });

  it('bounds every analytics aggregate with maxTimeMS', async () => {
    await Transaction.create(basket(cafeId, new Date('2026-01-13T09:00:00+02:00'), ['Flat White', 'Brownie']));
    const aggregate = jest.spyOn(Transaction, 'aggregate');

    for (const path of ['revenue', 'items', 'heatmap', 'customers', 'combos']) {
      expect((await get(path, WINDOW)).status).toBe(200);
    }

    expect(aggregate.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of aggregate.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ maxTimeMS: 20000 }));
    }
  });

  it('turns a query timeout into a 503 that tells the owner what to do', async () => {
    jest.spyOn(Transaction, 'aggregate').mockRejectedValueOnce(
      Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' })
    );

    const res = await get('customers', WINDOW);

    expect(res.status).toBe(503);
    expect(res.body.details).toEqual({ code: 'ANALYTICS_QUERY_TIMEOUT' });
    expect(res.body.message).toMatch(/shorter range/i);
  });
});
