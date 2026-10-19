// BE-13-T06 regression from reviewer-b90-2: how long "Keep all N" takes at the plan's cap and on a year-sized first import, all in one transaction.
const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Item = require('../../src/models/Item.model');
const Transaction = require('../../src/models/Transaction.model');
const { rebuildItemsForCafe } = require('../../src/services/menuItems.service');

jest.setTimeout(180_000);
beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const seed = async (cafeId, { names, sales, linesPerSale }) => {
  const day = Date.parse('2026-01-01T08:00:00Z');
  for (let start = 0; start < sales; start += 10_000) {
    const batch = [];
    for (let i = start; i < Math.min(sales, start + 10_000); i += 1) {
      const items = Array.from({ length: linesPerSale }, (_, k) => ({ name: `Item ${(i * 7 + k * 13) % names}`, quantity: 1, unitPrice: 30,
        menuItemStatus: 'needs_review' }));
      const date = new Date(day + (i % 365) * 86_400_000 + (i % 600) * 60_000);
      batch.push({ cafeId, status: 'approved', date, hour: date.getUTCHours(), dayOfWeek: date.getUTCDay(), items, total: 30 * linesPerSale,
        source: 'csv', receiptId: `R${i}`, dedupKey: `D${i}` });
    }
    await Transaction.collection.insertMany(batch);
  }
  await rebuildItemsForCafe(cafeId);
  return Item.countDocuments({ cafeId, reviewStatus: 'needs_review', isActive: { $ne: false } });
};

it.each([
  ['the cap: 2,000 waiting items, 20,000 sales', { names: 2_000, sales: 20_000, linesPerSale: 2 }],
  ['a year-sized first import: 300 items, 100,000 sales', { names: 300, sales: 100_000, linesPerSale: 3 }],
])('%s', async (label, shape) => {
  const { token, user } = await createTestUser();
  const cafeId = new mongoose.Types.ObjectId(String(user.activeCafeId));
  const waiting = await seed(cafeId, shape);
  const started = Date.now();
  const response = await supertest(app).post('/api/items/confirm-all-new').set('Authorization', `Bearer ${token}`).send({ expectedCount: waiting });
  const ms = Date.now() - started;
  const left = await Item.countDocuments({ cafeId, reviewStatus: 'needs_review' });
  const unlinked = await Transaction.countDocuments({ cafeId, 'items.menuItemStatus': 'needs_review' });
  console.log(`SCALE ${label}: waiting ${waiting}, status ${response.status} ${response.body?.code || ''} ${response.body?.message || ''}, ${ms} ms, items still waiting ${left}, sales with a waiting line ${unlinked}`);
  expect(response.status).toBe(200);
  expect(response.body.confirmed).toBe(shape.names);
  expect(left).toBe(0);
  expect(unlinked).toBe(0);
  expect(ms).toBeLessThan(40_000);
});
