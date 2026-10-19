const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Item = require('../../src/models/Item.model');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const CSV = [
  'Receipt,Date,Time,Items,Total',
  'R1,2026-04-01,08:30,1 x Flat White,35.00',
  'R2,2026-04-01,09:00,1 x Almond Croissant,45.00',
  'R3,2026-04-02,10:00,2 x Rooibos Latte,70.00',
].join('\n');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => { mockR2Files.clear(); await clearDB(); });

const importCsv = async (token, csv = CSV) => {
  const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', Buffer.from(csv), 'first.csv');
  const confirm = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
    .send({ columnMapping: MAPPING, itemsMode: 'packed' });
  expect(confirm.status).toBe(200);
};
const keepAll = (token, body) => request.post('/api/items/confirm-all-new').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /api/items/confirm-all-new (BE-13-T06)', () => {
  it('confirms every item from a first import in one request', async () => {
    const { token } = await createTestUser();
    await importCsv(token);
    expect(await Item.countDocuments({ reviewStatus: 'needs_review' })).toBe(3);

    const res = await keepAll(token, { expectedCount: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, confirmed: 3, meta: { needsReview: 0 } });
    expect(await Item.countDocuments({ reviewStatus: 'matched', isActive: { $ne: false } })).toBe(3);
    const lines = (await Transaction.find({}).lean()).flatMap((tx) => tx.items);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.menuItemStatus === 'matched')).toBe(true);
  });

  it('changes nothing when the queue is not the one the owner saw', async () => {
    const { token } = await createTestUser();
    await importCsv(token);

    const res = await keepAll(token, { expectedCount: 2 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ITEM_COUNT_CHANGED', details: { expected: 2, actual: 3 } });
    expect(await Item.countDocuments({ reviewStatus: 'needs_review' })).toBe(3);
  });

  it("touches only the caller's cafe", async () => {
    const first = await createTestUser();
    const second = await createTestUser({ email: 'second@yourguava.com' });
    await importCsv(first.token);
    await importCsv(second.token);

    expect((await keepAll(first.token, { expectedCount: 3 })).status).toBe(200);

    expect(await Item.countDocuments({ cafeId: second.user.activeCafeId, reviewStatus: 'needs_review' })).toBe(3);
  });

  it('refuses a missing or malformed expectedCount', async () => {
    const { token } = await createTestUser();
    await importCsv(token);
    for (const body of [{}, { expectedCount: 'all' }, { expectedCount: 0 }, { expectedCount: 2.5 }, { expectedCount: 2001 }]) {
      expect((await keepAll(token, body)).status).toBe(400);
    }
    expect(await Item.countDocuments({ reviewStatus: 'needs_review' })).toBe(3);
  });

  it('names the item a merged item was merged into', async () => {
    const { token } = await createTestUser();
    await importCsv(token);
    const [source, target] = await Item.find({}).sort({ name: 1 }).lean();
    await request.post(`/api/items/${target._id}/resolve`).set('Authorization', `Bearer ${token}`).send({ action: 'confirm' });
    await request.post(`/api/items/${source._id}/resolve`).set('Authorization', `Bearer ${token}`).send({ action: 'map_to', targetItemId: String(target._id) });

    const res = await request.get('/api/items?active=false').set('Authorization', `Bearer ${token}`);

    const merged = res.body.items.find((item) => item.reviewStatus === 'merged');
    expect(merged.mergedInto).toEqual({ _id: String(target._id), name: target.name });
  });

  it('rolls every item and sales line back when the rebuild fails', async () => {
    const { token } = await createTestUser();
    await importCsv(token);
    const beforeItems = await Item.find({}).sort({ _id: 1 }).lean();
    const beforeSales = await Transaction.find({}).sort({ _id: 1 }).lean();
    const rebuild = jest.spyOn(Transaction, 'aggregate').mockRejectedValueOnce(new Error('rebuild unavailable'));
    try {
      expect((await keepAll(token, { expectedCount: 3 })).status).toBe(500);
    } finally { rebuild.mockRestore(); }
    expect(await Item.find({}).sort({ _id: 1 }).lean()).toEqual(beforeItems);
    expect(await Transaction.find({}).sort({ _id: 1 }).lean()).toEqual(beforeSales);
  });

  it('keeps an existing price mismatch while confirming new items', async () => {
    const { token } = await createTestUser();
    await importCsv(token);
    const sale = await Transaction.findOne({});
    sale.items[0].menuItemStatus = 'price_mismatch';
    sale.items[0].priceVariancePct = 18;
    await sale.save();
    expect((await keepAll(token, { expectedCount: 3 })).status).toBe(200);
    const updated = await Transaction.findById(sale._id).lean();
    expect(updated.items[0].menuItemStatus).toBe('price_mismatch');
    expect(updated.items[0].priceVariancePct).toBe(18);
  });

  it('refuses more than 2000 waiting items without changing any', async () => {
    const { token, user } = await createTestUser();
    await Item.insertMany(Array.from({ length: 2001 }, (_, index) => ({ cafeId: user.activeCafeId,
      name: `Pending ${index}`, category: 'coffee', reviewStatus: 'needs_review', isActive: true })));
    const response = await keepAll(token, { expectedCount: 1 });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'TOO_MANY_ITEMS', details: { actual: 2001, max: 2000 } });
    expect(await Item.countDocuments({ reviewStatus: 'needs_review' })).toBe(2001);
  });
});
