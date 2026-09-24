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
const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');

const request = supertest(app);
const LF = String.fromCharCode(10);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const importLines = async (token, lines, name, columnMapping, itemsMode = 'packed') => {
  const staged = await request
    .post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(lines.join(LF)), name);
  expect(staged.status).toBe(200);
  return request
    .post(`/api/uploads/${staged.body.uploadId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ columnMapping, itemsMode });
};

const PACKED = { receiptId: 'Receipt', date: 'Date', time: 'Time', status: 'Status', items: 'Items', total: 'Total' };

describe('refunds and partial refunds reach the books at what the cafe kept', () => {
  it('nets a refund row into the partially refunded sale it refunds', async () => {
    const { token } = await createTestUser();
    const res = await importLines(token, [
      'Receipt,Date,Time,Status,Items,Total',
      'R20,2026-09-14,09:00,Partially Refunded,"1 x Latte, 1 x Muffin",68.00',
      'R20,2026-09-14,09:40,Refunded,-1 x Muffin,-30.00',
      'R21,2026-09-14,10:00,Approved,1 x Scone,32.00',
    ], 'partial-refund.csv', PACKED);

    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ imported: 2, skipped: 1, errors: 0 });
    expect(res.body.stats.skippedByReason).toEqual({ refund_netted: 1 });
    const r20 = await Transaction.findOne({ receiptId: 'R20' }).lean();
    expect(r20.total).toBe(38);
    expect(r20.items.map((item) => [item.name, item.quantity])).toEqual([['Latte', 1], ['Muffin', 1], ['Muffin', -1]]);
    expect(r20.items.every((item) => item.priceSource === 'derived')).toBe(true);
  });

  it('imports a partial refund with no refund row at its full amount, and says so', async () => {
    const { token } = await createTestUser();
    const res = await importLines(token, [
      'Receipt,Date,Time,Status,Items,Total',
      'R30,2026-09-14,11:00,Partially Refunded,1 x Cake,100.00',
    ], 'partial-refund-no-row.csv', PACKED);

    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ imported: 1, errors: 0 });
    expect((await Transaction.findOne({ receiptId: 'R30' }).lean()).total).toBe(100);
    expect(res.body.rowErrors.map((error) => error.reason)).toEqual([
      'Receipt R30 is marked Partially Refunded, but the file has no refund row for it, so its full R100.00 was imported.',
    ]);
  });

  it('does not flag a refunded line as a price mismatch or learn a price of 0 from it', async () => {
    const { token } = await createTestUser();
    const res = await importLines(token, [
      'Receipt,Date,Time,Item,Qty,Line Total',
      'R8,2026-09-13,09:00,Muffin,1,30.00',
      'R9,2026-09-14,09:00,Latte,1,38.00',
      'R9,2026-09-14,09:00,Muffin,-1,-30.00',
    ], 'line-per-row-refunds.csv', {
      receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Item', quantity: 'Qty', total: 'Line Total',
    }, 'line-per-row');

    expect(res.status).toBe(200);
    const r9 = await Transaction.findOne({ receiptId: 'R9' }).lean();
    expect(r9.items.find((item) => item.quantity < 0).menuItemStatus).not.toBe('price_mismatch');
    const muffin = await Item.findOne({ name: 'Muffin' }).lean();
    expect(muffin.priceMismatchCount || 0).toBe(0);
    expect(muffin.expectedPrice).not.toBe(0);
  });
});
