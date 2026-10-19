// GET /analytics/combos answers the same list for the same request (BE-14-T02): pairs with equal counts are ordered by the pair
// itself, so neither the order nor which tied pairs make the top 20 depends on MongoDB's grouping order.
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);
beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const DAY = '2026-08-31';
const NAMES = ['Apple Tart', 'Brownie', 'Cortado', 'Danish', 'Espresso', 'Flapjack', 'Granola', 'Hot Chocolate', 'Iced Tea', 'Jaffle'];

describe('combos ordering', () => {
  it('orders pairs by count, then by the pair, so the top 20 of 25 tied pairs is always the same list', async () => {
    const owner = await createTestUser();
    const cafeId = owner.user.activeCafeId;
    // 25 distinct pairs, one basket each: every pair ties at count 1, and five must fall below the top-20 cut.
    const pairs = [];
    for (let i = 0; i < NAMES.length && pairs.length < 25; i += 1) {
      for (let j = i + 1; j < NAMES.length && pairs.length < 25; j += 1) pairs.push([NAMES[j], NAMES[i]]);
    }
    // One more basket of the last pair makes it the single leader, ahead of every tie.
    const baskets = [...pairs, pairs[pairs.length - 1]];
    await Transaction.insertMany(baskets.map(([a, b], index) => ({
      cafeId, receiptId: `C${index}`, date: new Date(`${DAY}T${String(8 + (index % 10)).padStart(2, '0')}:${String(index).padStart(2, '0')}:00+02:00`),
      hour: 8 + (index % 10), dayOfWeek: 1, status: 'approved', total: 60, source: 'csv',
      items: [{ name: a, quantity: 1, unitPrice: 30 }, { name: b, quantity: 1, unitPrice: 30 }],
    })));

    const responses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await request.get('/api/analytics/combos').set('Authorization', `Bearer ${owner.token}`)
        .query({ startDate: DAY, endDate: DAY, refresh: 'true' });
      expect(res.status).toBe(200);
      responses.push(res.body.data);
    }

    const leader = [...pairs[pairs.length - 1]].sort();
    const tied = pairs.slice(0, -1).map((pair) => [...pair].sort())
      .sort((x, y) => (x[0] === y[0] ? x[1].localeCompare(y[1]) : x[0].localeCompare(y[0])));
    const expected = [{ pair: leader, count: 2 }, ...tied.slice(0, 19).map((pair) => ({ pair, count: 1 }))];
    expect(responses[0]).toEqual(expected);
    expect(responses[1]).toEqual(expected);
    expect(responses[2]).toEqual(expected);
  });
});
