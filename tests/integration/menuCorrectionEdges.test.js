// BE-03-T10 review focus: merge chains at the hop limit, sibling renames, the target's own mismatches on a link,
// tolerance-only edits, and owner-touched items surviving an upload delete.
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
const LF = String.fromCharCode(10);
const MAP = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);
const stageAndConfirm = async (token, text) => {
  const stage = await auth(request.post('/api/transactions/upload'), token).attach('file', Buffer.from(text), 'menu.csv');
  const confirm = await auth(request.post(`/api/uploads/${stage.body.uploadId}/confirm`), token)
    .send({ columnMapping: MAP, itemsMode: 'packed' });
  expect(confirm.status).toBe(200);
  return stage.body.uploadId;
};
const csv = (...rows) => ['Receipt,Date,Time,Items,Total', ...rows].join(LF);
const lineOf = async (cafeId, receiptId) => (await Transaction.findOne({ cafeId, receiptId }).lean()).items[0];

// A chain of merged items made by hand (map_to refuses merged targets, so only old data or the database can make one).
const mergeChain = async (cafeId, length) => {
  const items = await Item.create(Array.from({ length: length + 1 }, (_, i) => ({
    cafeId, name: `Chain ${i}`, normalizedName: `chain ${i}`,
    reviewStatus: i < length ? 'merged' : 'matched', isActive: i >= length,
  })));
  for (let i = 0; i < length; i += 1) await Item.updateOne({ _id: items[i]._id }, { mergedInto: items[i + 1]._id });
  return items;
};

describe('merge chains', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('follows a chain of five merges to its active root', async () => {
    const items = await mergeChain(cafeId, 5);
    await stageAndConfirm(token, csv('H1,2026-04-01,08:30,1 x Chain 0,38.00'));
    expect(String((await lineOf(cafeId, 'H1')).salesItemId)).toBe(String(items[5]._id));
  });

  it('stops at the hop limit on a chain of six and still imports the sale', async () => {
    const items = await mergeChain(cafeId, 6);
    await stageAndConfirm(token, csv('H2,2026-04-01,08:30,1 x Chain 0,38.00'));
    const linked = String((await lineOf(cafeId, 'H2')).salesItemId);
    expect(items.map((item) => String(item._id))).toContain(linked);
    expect(linked).not.toBe(String(items[6]._id));
  });
});

describe('renames and links leave other items alone', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('does not keep a sibling variant as an alias when a variant is renamed to its sibling', async () => {
    const large = await auth(request.post('/api/items'), token).send({ name: 'Cappuccino (Large)', category: 'coffee' });
    const renamed = await auth(request.put(`/api/items/${large.body.item._id}`), token).send({ name: 'Cappuccino (Small)' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.item.aliases).not.toContain('Cappuccino (Large)');
  });

  it('keeps the target\'s own price mismatches when another item is linked to it', async () => {
    const latte = await auth(request.post('/api/items'), token).send({ name: 'Latte', category: 'coffee', expectedPrice: 30 });
    await stageAndConfirm(token, csv('T1,2026-04-01,08:30,1 x Latte,45.00', 'T2,2026-04-01,09:00,1 x Lattee,30.00'));
    expect((await lineOf(cafeId, 'T1')).menuItemStatus).toBe('price_mismatch');
    const lattee = await Item.findOne({ cafeId, name: 'Lattee' }).lean();

    const linked = await auth(request.post(`/api/items/${lattee._id}/resolve`), token)
      .send({ action: 'map_to', targetItemId: latte.body.item._id });

    expect(linked.status).toBe(200);
    expect((await lineOf(cafeId, 'T1')).menuItemStatus).toBe('price_mismatch');
    expect(await lineOf(cafeId, 'T2')).toMatchObject({ menuItemStatus: 'matched', name: 'Latte', rawName: 'Lattee' });
  });

  it('leaves mismatches and forecasts alone when only the price tolerance changes', async () => {
    const latte = await auth(request.post('/api/items'), token).send({ name: 'Latte', category: 'coffee', expectedPrice: 30 });
    await stageAndConfirm(token, csv('W1,2026-04-01,08:30,1 x Latte,45.00'));
    const planned = await Forecast.create({
      cafeId, date: new Date(Date.now() + 36 * 3600 * 1000), generatedAt: new Date(),
      items: [{ itemName: 'Latte', predictedQty: 3 }], totalPredictedRevenue: 90,
    });

    const res = await auth(request.put(`/api/items/${latte.body.item._id}`), token).send({ priceTolerancePct: 60 });

    expect(res.status).toBe(200);
    expect((await lineOf(cafeId, 'W1')).menuItemStatus).toBe('price_mismatch');
    expect(await Forecast.exists({ _id: planned._id })).toBeTruthy();
  });

  // Found in the BE-03-T10 browser run: MenuItems.tsx sends the card's own category and price with every Link, and
  // map_to wrote them onto the target as the owner's, so linking "Capuccino" turned Cappuccino from coffee to other.
  it('keeps the target\'s category and price when a link sends the card\'s own values back', async () => {
    const target = await auth(request.post('/api/items'), token).send({ name: 'Cappuccino', category: 'coffee', expectedPrice: 38 });
    await stageAndConfirm(token, csv('K1,2026-04-01,08:30,1 x Capuccino,45.00'));
    const source = await Item.findOne({ cafeId, name: 'Capuccino' }).lean();

    const linked = await auth(request.post(`/api/items/${source._id}/resolve`), token).send({
      action: 'map_to', targetItemId: target.body.item._id, category: source.category, expectedPrice: source.expectedPrice,
    });

    expect(linked.status).toBe(200);
    expect(await Item.findById(target.body.item._id).lean()).toMatchObject({ category: 'coffee', expectedPrice: 38 });
  });

  it('applies a category the owner changed on the card before linking', async () => {
    const target = await auth(request.post('/api/items'), token).send({ name: 'Cappuccino', category: 'other', expectedPrice: 38 });
    await stageAndConfirm(token, csv('K2,2026-04-01,08:30,1 x Capuccino,38.00'));
    const source = await Item.findOne({ cafeId, name: 'Capuccino' }).lean();

    await auth(request.post(`/api/items/${source._id}/resolve`), token).send({
      action: 'map_to', targetItemId: target.body.item._id, category: 'coffee', expectedPrice: source.expectedPrice,
    });

    const stored = await Item.findById(target.body.item._id).lean();
    expect(stored).toMatchObject({ category: 'coffee', expectedPrice: 38 });
    expect(stored.manualFields).toContain('category');
  });

  // Review of BE-03-T10: the PUT relinked only the item's old names, so an alias the owner added no longer picked
  // up old lines written before lines carried an id.
  it('links old id-less lines to an alias the owner adds', async () => {
    const cappuccino = await auth(request.post('/api/items'), token).send({ name: 'Cappuccino', category: 'coffee' });
    await Transaction.create({
      cafeId, date: new Date('2026-04-01T06:30:00Z'), status: 'approved', total: 38, source: 'csv',
      items: [{ name: 'Capp', quantity: 1, unitPrice: 38 }],
    });

    await auth(request.put(`/api/items/${cappuccino.body.item._id}`), token).send({ aliases: ['Capp'] });

    const line = (await Transaction.findOne({ cafeId }).lean()).items[0];
    expect(String(line.salesItemId)).toBe(cappuccino.body.item._id);
  });

  // Review of BE-03-T10: linking an item that others were already linked to made a two-hop chain; six such links
  // passed the resolver's hop limit and new sales landed on a merged item.
  it('keeps merge chains one hop long when a link target is itself linked onward', async () => {
    await stageAndConfirm(token, csv('J1,2026-04-01,08:30,1 x Capuccino;1 x Cappucino;1 x Cappuccino,114.00'));
    const [a, b, c] = await Promise.all(['Capuccino', 'Cappucino', 'Cappuccino'].map((name) => Item.findOne({ cafeId, name }).lean()));
    await auth(request.post(`/api/items/${b._id}/resolve`), token).send({ action: 'confirm' });
    await auth(request.post(`/api/items/${c._id}/resolve`), token).send({ action: 'confirm' });
    await auth(request.post(`/api/items/${a._id}/resolve`), token).send({ action: 'map_to', targetItemId: String(b._id) });

    await auth(request.post(`/api/items/${b._id}/resolve`), token).send({ action: 'map_to', targetItemId: String(c._id) });

    expect(String((await Item.findById(a._id).lean()).mergedInto)).toBe(String(c._id));
  });

  it('refuses to link to an item whose id belongs to another cafe', async () => {
    const other = await createTestUser({ email: 'other-cafe@example.com' });
    const foreign = await auth(request.post('/api/items'), other.token).send({ name: 'Foreign Latte', category: 'coffee' });
    await stageAndConfirm(token, csv('F1,2026-04-01,08:30,1 x Mocha,40.00'));
    const mocha = await Item.findOne({ cafeId, name: 'Mocha' }).lean();

    const res = await auth(request.post(`/api/items/${mocha._id}/resolve`), token).send({ action: 'map_to', targetItemId: foreign.body.item._id });

    expect(res.status).toBe(404);
    expect((await Item.findById(mocha._id).lean()).reviewStatus).toBe('needs_review');
  });
});

describe('orphans are only removed inside a transaction', () => {
  const mongoose = require('mongoose');
  const { rebuildItemsForCafe } = require('../../src/services/menuItems.service');
  let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); cafeId = owner.user.activeCafeId; });

  // Review of BE-03-T10: a rebuild without a session (a Link, an edit, every Yoco webhook) has no snapshot, so a
  // brand-new item whose first sale was being written at that moment looked unsold and was deleted, leaving the
  // sale pointing at nothing.
  it('leaves an unsold imported item alone when the rebuild runs outside a transaction', async () => {
    const fresh = await Item.create({ cafeId, name: 'Iced Chai', normalizedName: 'iced chai', source: 'imported', reviewStatus: 'needs_review' });
    await rebuildItemsForCafe(cafeId);
    expect(await Item.findById(fresh._id).lean()).not.toBeNull();
  });

  it('removes it when the rebuild runs inside the caller\'s transaction', async () => {
    const orphan = await Item.create({ cafeId, name: 'Iced Chai', normalizedName: 'iced chai', source: 'imported', reviewStatus: 'needs_review' });
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => rebuildItemsForCafe(cafeId, { session }));
    } finally {
      await session.endSession();
    }
    expect(await Item.findById(orphan._id).lean()).toBeNull();
  });
});

describe('owner-touched items survive their upload being deleted', () => {
  let token; let cafeId;
  beforeEach(async () => { const owner = await createTestUser(); token = owner.token; cafeId = owner.user.activeCafeId; });

  it('keeps a renamed item, and one with notes, but removes the untouched one', async () => {
    const uploadId = await stageAndConfirm(token, csv('D1,2026-04-01,08:30,1 x FLT WHT;1 x Noted;1 x Plain,60.00'));
    const flat = await Item.findOne({ cafeId, name: 'FLT WHT' }).lean();
    const noted = await Item.findOne({ cafeId, name: 'Noted' }).lean();
    await auth(request.put(`/api/items/${flat._id}`), token).send({ name: 'Flat White' });
    await auth(request.put(`/api/items/${noted._id}`), token).send({ notes: 'Seasonal' });

    const removed = await auth(request.delete(`/api/uploads/${uploadId}`), token);

    expect(removed.status).toBe(200);
    expect(await Item.findById(flat._id).lean()).toMatchObject({ name: 'Flat White', totalSold: 0 });
    expect(await Item.findById(noted._id).lean()).toMatchObject({ notes: 'Seasonal', totalSold: 0 });
    expect(await Item.findOne({ cafeId, name: 'Plain' }).lean()).toBeNull();
  });
});
