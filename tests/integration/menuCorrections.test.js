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
const Forecast = require('../../src/models/Forecast.model');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const request = supertest(app);
const MAP = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);
const stageAndConfirm = async (token, csv, mapping = MAP) => {
  const stage = await auth(request.post('/api/transactions/upload'), token).attach('file', Buffer.from(csv), 'menu.csv');
  const confirm = await auth(request.post(`/api/uploads/${stage.body.uploadId}/confirm`), token)
    .send({ columnMapping: mapping, itemsMode: 'packed' });
  expect(confirm.status).toBe(200);
  return stage.body.uploadId;
};
const csv = (...rows) => ['Receipt,Date,Time,Items,Total', ...rows].join('\n');

describe('menu corrections survive the next import', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('keeps a merged spelling on its target when the next file uses it again', async () => {
    const target = await auth(request.post('/api/items'), token).send({ name: 'Cappuccino', category: 'coffee', expectedPrice: 38 });
    await stageAndConfirm(token, csv('M1,2026-04-01,08:30,1 x Capuccino,38.00'));
    const source = await Item.findOne({ cafeId, name: 'Capuccino' }).lean();
    const linked = await auth(request.post(`/api/items/${source._id}/resolve`), token)
      .send({ action: 'map_to', targetItemId: target.body.item._id });
    expect(linked.status).toBe(200);

    await stageAndConfirm(token, csv('M2,2026-04-02,08:30,1 x Capuccino,38.00'));

    const second = await Transaction.findOne({ cafeId, receiptId: 'M2' }).lean();
    expect(String(second.items[0].salesItemId)).toBe(target.body.item._id);
    expect(second.items[0]).toMatchObject({ name: 'Cappuccino', rawName: 'Capuccino', menuItemStatus: 'matched' });
    expect((await Item.findById(target.body.item._id).lean()).totalSold).toBe(2);
    expect((await Item.findById(source._id).lean()).totalSold).toBe(0);
  });

  it('keeps the till spelling when an item is renamed, so the next import finds it', async () => {
    await stageAndConfirm(token, csv('N1,2026-04-01,08:30,1 x FLT WHT,38.00'));
    const item = await Item.findOne({ cafeId, name: 'FLT WHT' }).lean();
    const renamed = await auth(request.put(`/api/items/${item._id}`), token).send({ name: 'Flat White' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.item.aliases).toContain('FLT WHT');

    await stageAndConfirm(token, csv('N2,2026-04-02,08:30,1 x FLT WHT,38.00'));

    expect(await Item.countDocuments({ cafeId })).toBe(1);
    const second = await Transaction.findOne({ cafeId, receiptId: 'N2' }).lean();
    expect(String(second.items[0].salesItemId)).toBe(String(item._id));
    expect(second.items[0].name).toBe('Flat White');
  });

  it('still resolves a merged spelling after the owner clears the target\'s aliases', async () => {
    const target = await auth(request.post('/api/items'), token).send({ name: 'Cappuccino', category: 'coffee' });
    await stageAndConfirm(token, csv('A1,2026-04-01,08:30,1 x Capuccino,38.00'));
    const source = await Item.findOne({ cafeId, name: 'Capuccino' }).lean();
    await auth(request.post(`/api/items/${source._id}/resolve`), token).send({ action: 'map_to', targetItemId: target.body.item._id });
    await auth(request.put(`/api/items/${target.body.item._id}`), token).send({ aliases: [] });

    await stageAndConfirm(token, csv('A2,2026-04-02,08:30,1 x Capuccino,38.00'));

    const second = await Transaction.findOne({ cafeId, receiptId: 'A2' }).lean();
    expect(String(second.items[0].salesItemId)).toBe(target.body.item._id);
  });

  // Review focus: map_to refuses merged targets, so a cycle can only be made by hand; following it must still end.
  it('finishes an import when two merged items point at each other', async () => {
    const [a, b] = await Item.create([
      { cafeId, name: 'Cappuccino', normalizedName: 'cappuccino', reviewStatus: 'merged', isActive: false },
      { cafeId, name: 'Capuccino', normalizedName: 'capuccino', reviewStatus: 'merged', isActive: false },
    ]);
    await Item.updateOne({ _id: a._id }, { mergedInto: b._id });
    await Item.updateOne({ _id: b._id }, { mergedInto: a._id });

    await stageAndConfirm(token, csv('C1,2026-04-01,08:30,1 x Capuccino,38.00'));

    const line = (await Transaction.findOne({ cafeId, receiptId: 'C1' }).lean()).items[0];
    expect([String(a._id), String(b._id)]).toContain(String(line.salesItemId));
  });
});

describe('edits that do not change what an item is leave its sales alone', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('keeps price mismatches and future forecasts through a notes-only edit', async () => {
    const created = await auth(request.post('/api/items'), token).send({ name: 'Latte', category: 'coffee', expectedPrice: 30 });
    await stageAndConfirm(token, csv('P1,2026-04-01,08:30,1 x Latte,45.00'));
    // Created after the confirm, whose post-import maintenance (synchronous under NODE_ENV=test) regenerates the week.
    const planned = await Forecast.create({
      cafeId, date: new Date(Date.now() + 36 * 3600 * 1000), generatedAt: new Date(),
      items: [{ itemName: 'Latte', predictedQty: 3 }], totalPredictedRevenue: 90,
    });
    const futureBefore = await Forecast.countDocuments({ cafeId, date: { $gte: new Date() } });

    // What MenuItems.tsx's putItem sends on Save (draftPayload's category, expectedPrice, priceTolerancePct and aliases,
    // plus reviewStatus), all unchanged, plus a notes edit (the portal has no notes field; the API accepts one).
    const stored = await Item.findById(created.body.item._id).lean();
    const res = await auth(request.put(`/api/items/${stored._id}`), token).send({
      category: stored.category, expectedPrice: stored.expectedPrice, priceTolerancePct: stored.priceTolerancePct,
      aliases: stored.aliases, reviewStatus: stored.reviewStatus, notes: 'Oat milk by default',
    });
    expect(res.status).toBe(200);

    const line = (await Transaction.findOne({ cafeId, receiptId: 'P1' }).lean()).items[0];
    expect(line.menuItemStatus).toBe('price_mismatch');
    expect(line.priceVariancePct).toBeCloseTo(50, 2);
    expect((await Item.findById(stored._id).lean()).priceMismatchCount).toBe(1);
    expect(await Forecast.exists({ _id: planned._id })).toBeTruthy();
    expect(await Forecast.countDocuments({ cafeId, date: { $gte: new Date() } })).toBe(futureBefore);
    expect((await Item.findById(stored._id).lean()).manualFields).toEqual([]);
  });
});

describe('link and rename rules', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('refuses to link an item to itself', async () => {
    await stageAndConfirm(token, csv('S1,2026-04-01,08:30,1 x Mocha,40.00'));
    const item = await Item.findOne({ cafeId, name: 'Mocha' }).lean();
    const res = await auth(request.post(`/api/items/${item._id}/resolve`), token).send({ action: 'map_to', targetItemId: String(item._id) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MAP_TO_SELF' });
    expect(await Item.findById(item._id).lean()).toMatchObject({ reviewStatus: 'needs_review', isActive: true });
  });

  it('refuses to link to an ignored or already-merged item', async () => {
    await stageAndConfirm(token, csv('I1,2026-04-01,08:30,1 x Delivery Fee;1 x Scone;1 x Scon,60.00'));
    const fee = await Item.findOne({ cafeId, name: 'Delivery Fee' }).lean();
    const scone = await Item.findOne({ cafeId, name: 'Scone' }).lean();
    const scon = await Item.findOne({ cafeId, name: 'Scon' }).lean();
    await auth(request.post(`/api/items/${fee._id}/resolve`), token).send({ action: 'ignore' });
    await auth(request.post(`/api/items/${scone._id}/resolve`), token).send({ action: 'confirm' });
    await auth(request.post(`/api/items/${scon._id}/resolve`), token).send({ action: 'map_to', targetItemId: String(scone._id) });

    const toIgnored = await auth(request.post(`/api/items/${scone._id}/resolve`), token).send({ action: 'map_to', targetItemId: String(fee._id) });
    const toMerged = await auth(request.post(`/api/items/${scone._id}/resolve`), token).send({ action: 'map_to', targetItemId: String(scon._id) });
    expect(toIgnored.status).toBe(400);
    expect(toIgnored.body.code).toBe('MAP_TO_INACTIVE_TARGET');
    expect(toMerged.status).toBe(400);
    expect(toMerged.body.code).toBe('MAP_TO_INACTIVE_TARGET');
    expect((await Item.findById(scone._id).lean()).reviewStatus).toBe('matched');
  });

  it('refuses a rename onto another item\'s name, whatever the case', async () => {
    await auth(request.post('/api/items'), token).send({ name: 'Flat White', category: 'coffee' });
    const latte = await auth(request.post('/api/items'), token).send({ name: 'Latte', category: 'coffee' });
    const res = await auth(request.put(`/api/items/${latte.body.item._id}`), token).send({ name: 'flat white' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ITEM_NAME_TAKEN');
    expect((await Item.findById(latte.body.item._id).lean()).name).toBe('Latte');
  });
});

describe('imported items left with no sales are cleaned up', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('removes items created by a wrong Items column once the upload is remapped', async () => {
    const text = ['Receipt,Date,Time,Payment,Items,Total', 'W1,2026-04-01,08:30,Card,1 x Latte,38.00', 'W2,2026-04-01,09:00,Cash,1 x Scone,28.00'].join('\n');
    const uploadId = await stageAndConfirm(token, text, { ...MAP, items: 'Payment' });
    expect(await Item.countDocuments({ cafeId, name: { $in: ['Card', 'Cash'] } })).toBe(2);

    const remap = await auth(request.patch(`/api/uploads/${uploadId}/mapping`), token).send({ columnMapping: MAP, itemsMode: 'packed' });
    expect(remap.status).toBe(200);

    expect(await Item.countDocuments({ cafeId, name: { $in: ['Card', 'Cash'] } })).toBe(0);
    const queue = await auth(request.get('/api/items/reconciliation'), token);
    expect(queue.body.items.map((item) => item.name).sort()).toEqual(['Latte', 'Scone']);
  });

  it('removes items whose only sales were in a deleted upload, but keeps ones the owner touched', async () => {
    const uploadId = await stageAndConfirm(token, csv('X1,2026-04-01,08:30,1 x Mystery;1 x Keeper,40.00'));
    const keeper = await Item.findOne({ cafeId, name: 'Keeper' }).lean();
    await auth(request.put(`/api/items/${keeper._id}`), token).send({ category: 'food' });

    const removed = await auth(request.delete(`/api/uploads/${uploadId}`), token);
    expect(removed.status).toBe(200);

    expect(await Item.findOne({ cafeId, name: 'Mystery' }).lean()).toBeNull();
    expect(await Item.findOne({ cafeId, name: 'Keeper' }).lean()).toMatchObject({ category: 'food', totalSold: 0 });
  });
});
