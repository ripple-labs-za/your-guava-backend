const mockR2Files = new Map();
let mockR2DeleteError = null;
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => {
    if (mockR2DeleteError) throw mockR2DeleteError;
    mockR2Files.delete(key);
  },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const { insertTransactionsInChunks } = require('../../src/services/ingestion.service');
const { measureBudget } = require('../helpers/budget');
const { countOperations, scannedDocuments, yocoCsv, seedTransactions, stageAndConfirm } = require('../helpers/perf');

const request = supertest(app);
jest.setTimeout(180_000); // 10,000-row imports on a loaded workstation; the budgets are asserted inside, not by the timeout

beforeAll(async () => {
  await setup();
  await Transaction.init(); // the unique and lookup indexes exist before anything is counted
});
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const cafeDocs = (count, cafeId) => Array.from({ length: count }, (_, i) => ({
  cafeId, receiptId: `R${i}`, date: new Date(Date.UTC(2026, 0, 5, 8, 0, i % 60)), hour: 10, dayOfWeek: 1,
  status: 'approved', items: [{ name: 'Latte', quantity: 1, unitPrice: 38 }], total: 38, source: 'csv',
}));

describe('import cost', () => {
  it('H5: a 10,000-row confirm never sends more than 1,000 transactions in one insert', async () => {
    const { token } = await createTestUser();
    const { result, calls } = await countOperations(() => stageAndConfirm(request, token, yocoCsv(10_000), 'yoco-10k.csv'));
    expect(result.confirm.status).toBe(200);
    expect(result.confirm.body.stats.imported).toBe(10_000);
    const inserts = calls.filter((c) => c.collectionName === 'transactions' && c.method === 'insertMany').map((c) => c.params[0].length);
    expect(inserts.reduce((sum, n) => sum + n, 0)).toBe(10_000);
    expect(Math.max(...inserts)).toBeLessThanOrEqual(1_000);
  });

  it('H5: chunks stop at the first duplicate, like one ordered insert, and a transaction rolls every chunk back', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    const docs = cafeDocs(3_000, cafeId);
    docs[2_500] = { ...docs[10] }; // the 2,501st document repeats the 11th: same cafe, receipt and instant
    await expect(insertTransactionsInChunks(docs)).rejects.toMatchObject({ code: 11000 });
    expect(await Transaction.countDocuments({ cafeId })).toBe(2_500);
    await Transaction.deleteMany({ cafeId });
    const session = await mongoose.startSession();
    try {
      await expect(session.withTransaction(() => insertTransactionsInChunks(docs, { session }))).rejects.toMatchObject({ code: 11000 });
    } finally {
      await session.endSession();
    }
    expect(await Transaction.countDocuments({ cafeId })).toBe(0);
  });

  it.each([0, -1, 0.5, 1001, NaN, Infinity])('H5: invalid chunk size %s fails before writing', async (chunkSize) => {
    const cafeId = new mongoose.Types.ObjectId();
    await expect(insertTransactionsInChunks(cafeDocs(1, cafeId), { chunkSize })).rejects.toThrow(RangeError);
    expect(await Transaction.countDocuments({ cafeId })).toBe(0);
  });

  it('H5: gives pending I/O a turn between bounded insert batches', async () => {
    let ioRan = false;
    const turns = [];
    const insert = jest.spyOn(Transaction, 'insertMany').mockImplementation(async () => {
      turns.push(ioRan);
      setImmediate(() => { ioRan = true; });
    });
    try {
      expect(await insertTransactionsInChunks([{}, {}, {}], { chunkSize: 1 })).toBe(3);
      expect(turns).toEqual([false, true, true]);
    } finally { insert.mockRestore(); }
  });

  it('H5: a 10,000-row confirm does not stall the event loop for 250 ms at a time', async () => {
    const { token } = await createTestUser();
    const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`)
      .attach('file', yocoCsv(10_000), 'yoco-10k.csv');
    expect(stage.status).toBe(200);
    const measured = await measureBudget(() => request.post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'b14-h5-loop')
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode }));
    expect(measured.error).toBeUndefined();
    expect(measured.result.status).toBe(200);
    expect(await Transaction.countDocuments({})).toBe(10_000);
    expect(measured.maxLoopDelayMs).toBeLessThan(250);
  });

  it('H7: confirming onto a long daily-reset history reads the stored sales once, not twice', async () => {
    const { token, user } = await createTestUser();
    // 75 days of a till that restarts at receipt 1 each morning, long before the file: 3,000 stored sales numbered 1..40.
    expect(await seedTransactions(user.activeCafeId, { days: 75, perDay: 40, endDay: '2025-09-30', receipt: (d, i) => String(i + 1) }))
      .toBe(3_000);
    const file = yocoCsv(800, { startDay: '2026-01-05', perDay: 80, receipt: (index) => String((index % 80) + 1) });
    const { result, scanned } = await scannedDocuments(() => stageAndConfirm(request, token, file, 'reset-daily.csv'));
    expect(result.confirm.status).toBe(200);
    expect(result.confirm.body.stats.imported).toBe(800);
    // The item rebuild reads every approved sale once (3,800). A receipt lookup without a date bound reads the 3,000 old
    // sales a second time; the bounded one reads only 4-15 Jan 2026, where nothing is stored.
    expect(scanned).toBeLessThan(3_000 + 800 + 1_500);
  });
});

const Item = require('../../src/models/Item.model');
const { rebuildItemsForCafe } = require('../../src/services/menuItems.service');

it.each([413, 499])('isolation: staging propagates parser status %s', async (statusCode) => {
  const { token } = await createTestUser();
  const ingestion = require('../../src/services/ingestion.service');
  const preview = jest.spyOn(ingestion, 'previewBuffer').mockRejectedValueOnce(
    Object.assign(new Error('Bounded parser refusal'), { statusCode }));
  try {
    const response = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`)
      .attach('file', yocoCsv(1), 'refused.csv');
    expect(response.status).toBe(statusCode);
    expect(response.body.message).toBe('Bounded parser refusal');
  } finally { preview.mockRestore(); }
});

const round6 = (value) => JSON.parse(JSON.stringify(value, (key, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));
const itemsOf = async (cafeId) => round6((await Item.find({ cafeId }).select('+salesStats').lean())
  .map(({ _id, createdAt, updatedAt, __v, ...rest }) => rest)
  .sort((a, b) => a.name.localeCompare(b.name)));

it('H6: an import onto 20,000 stored sales reads the new rows for item statistics, not the history', async () => {
  const { token, user } = await createTestUser();
  await stageAndConfirm(request, token, yocoCsv(200, { startDay: '2026-01-05', prefix: 'FIRST' }), 'first.csv');
  expect(await seedTransactions(user.activeCafeId, { days: 500, perDay: 40, endDay: '2025-12-31' })).toBe(20_000);
  await rebuildItemsForCafe(user.activeCafeId); // the stored statistics include the seeded history
  const { result, scanned } = await scannedDocuments(() => stageAndConfirm(request, token,
    yocoCsv(200, { startDay: '2026-02-02', prefix: 'TOPUP' }), 'top-up.csv'));
  expect(result.confirm.status).toBe(200);
  expect(result.confirm.body.stats.imported).toBe(200);
  expect(scanned).toBeLessThan(5_000); // a full rebuild reads all 20,400 approved sales
});

it('H6: items after an incremental rebuild equal a full rebuild, field for field', async () => {
  const { token, user } = await createTestUser();
  await stageAndConfirm(request, token, yocoCsv(600, { startDay: '2026-02-02', prefix: 'A' }), 'a.csv');
  const later = [['Rooibos Latte', 35], ['Flat White', 44], ['Croissant', 34], ['Muffin', 30]]; // a new item and a price change
  const second = await countOperations(() => stageAndConfirm(request, token,
    yocoCsv(400, { startDay: '2026-03-02', prefix: 'B', menu: later }), 'b.csv'));
  expect(second.result.confirm.status).toBe(200);
  // the incremental path really ran: the statistics read was scoped to this upload's rows
  expect(second.calls.some((c) => c.collectionName === 'transactions' && c.method === 'aggregate'
    && c.params[0][0]?.$match?.uploadId)).toBe(true);
  const incremental = await itemsOf(user.activeCafeId);
  await rebuildItemsForCafe(user.activeCafeId);
  expect(incremental).toEqual(await itemsOf(user.activeCafeId));
  expect(incremental.find((item) => item.name === 'Rooibos Latte').totalSold).toBeGreaterThan(0);
});

it('H6: legacy sums heal once and internal sums never appear in the menu response', async () => {
  const { token, user } = await createTestUser();
  await stageAndConfirm(request, token, yocoCsv(100, { prefix: 'LEGACY' }), 'legacy.csv');
  await Item.updateMany({ cafeId: user.activeCafeId }, { $unset: { salesStats: 1 } });
  const healed = await countOperations(() => stageAndConfirm(request, token,
    yocoCsv(100, { startDay: '2026-02-02', prefix: 'HEAL' }), 'heal.csv'));
  expect(healed.result.confirm.status).toBe(200);
  const statsReads = healed.calls.filter((c) => c.collectionName === 'transactions' && c.method === 'aggregate'
    && c.params[0].some((stage) => stage.$group?.lines));
  expect(statsReads).toHaveLength(1);
  expect(statsReads[0].params[0][0].$match.uploadId).toBeUndefined();
  const stored = await Item.find({ cafeId: user.activeCafeId }).select('+salesStats').lean();
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.every((item) => item.salesStats?.lines > 0)).toBe(true);
  const third = await countOperations(() => stageAndConfirm(request, token,
    yocoCsv(100, { startDay: '2026-03-02', prefix: 'NEXT' }), 'next.csv'));
  expect(third.result.confirm.status).toBe(200);
  expect(third.calls.some((c) => c.collectionName === 'transactions' && c.method === 'aggregate'
    && c.params[0][0]?.$match?.uploadId)).toBe(true);
  const response = await request.get('/api/items').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).not.toContain('salesStats');
  expect((await Item.findOne({ cafeId: user.activeCafeId }).lean()).salesStats).toBeUndefined();
});

it('H6: a merge and an upload deletion between additions preserve full-rebuild statistics', async () => {
  const { token, user } = await createTestUser();
  const first = await stageAndConfirm(request, token, yocoCsv(120, { prefix: 'MERGE' }), 'merge.csv');
  const source = await Item.findOne({ cafeId: user.activeCafeId, name: 'Cappuccino' });
  const target = await Item.findOne({ cafeId: user.activeCafeId, name: 'Latte' });
  const merged = await request.post(`/api/items/${source._id}/resolve`).set('Authorization', `Bearer ${token}`)
    .send({ action: 'map_to', targetItemId: String(target._id) });
  expect(merged.status).toBe(200);
  const second = await stageAndConfirm(request, token,
    yocoCsv(120, { startDay: '2026-02-02', prefix: 'AFTERMERGE' }), 'after-merge.csv');
  expect(second.confirm.status).toBe(200);
  const afterMerge = await itemsOf(user.activeCafeId);
  await rebuildItemsForCafe(user.activeCafeId);
  expect(await itemsOf(user.activeCafeId)).toEqual(afterMerge);
  const removed = await request.delete(`/api/uploads/${first.stage.body.uploadId}`).set('Authorization', `Bearer ${token}`);
  expect(removed.status).toBe(200);
  const third = await stageAndConfirm(request, token,
    yocoCsv(120, { startDay: '2026-03-02', prefix: 'AFTERDELETE' }), 'after-delete.csv');
  expect(third.confirm.status).toBe(200);
  const afterDelete = await itemsOf(user.activeCafeId);
  await rebuildItemsForCafe(user.activeCafeId);
  expect(await itemsOf(user.activeCafeId)).toEqual(afterDelete);
});

it('H6: remapping a completed upload replaces its sums instead of adding them again', async () => {
  const { token, user } = await createTestUser();
  const first = await stageAndConfirm(request, token, yocoCsv(120, { prefix: 'REMAP' }), 'remap.csv');
  expect(first.confirm.status).toBe(200);
  const before = await itemsOf(user.activeCafeId);
  const sums = (items) => items.map(({ name, totalSold, avgPrice, salesStats }) => ({
    name, totalSold, avgPrice, lines: salesStats.lines, totalQty: salesStats.totalQty, totalRevenue: salesStats.totalRevenue,
  }));
  const remapped = await request.patch(`/api/uploads/${first.stage.body.uploadId}/mapping`)
    .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'remap-replace-sums')
    .send({ columnMapping: first.stage.body.columnMapping, itemsMode: first.stage.body.itemsMode });
  expect(remapped.status).toBe(200);
  const afterRemap = await itemsOf(user.activeCafeId);
  // Replacing the transactions gives lastExactPrice.order a new transaction id; all business sums stay identical.
  expect(sums(afterRemap)).toEqual(sums(before));
  await rebuildItemsForCafe(user.activeCafeId, { pruneOrphans: true });
  expect(await itemsOf(user.activeCafeId)).toEqual(afterRemap);
  expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(120);
});

it('readmission: deleting a 10k-row overlapping upload keeps the event loop responsive', async () => {
  const { token } = await createTestUser();
  const original = yocoCsv(10_000, { prefix: 'READMIT' });
  const lines = original.toString().trimEnd().split('\n');
  const extra = yocoCsv(1, { prefix: 'READMIT-EXTRA' }).toString().trimEnd().split('\n')[1];
  const overlapping = Buffer.from([lines[0], ...lines.slice(2), extra].join('\n') + '\n');
  const first = await stageAndConfirm(request, token, original, 'readmit-original.csv');
  expect(first.confirm.status).toBe(200);
  const second = await stageAndConfirm(request, token, overlapping, 'readmit-overlap.csv');
  expect(second.confirm.status).toBe(200);
  expect(second.confirm.body.stats.imported).toBe(1);
  const outcome = await measureBudget(() => request.delete(`/api/uploads/${first.stage.body.uploadId}`)
    .set('Authorization', `Bearer ${token}`));
  expect(outcome.error).toBeUndefined();
  expect(outcome.result.status).toBe(200);
  expect(await Transaction.countDocuments({})).toBe(10_000);
  expect(outcome.maxLoopDelayMs).toBeLessThan(250);
});
