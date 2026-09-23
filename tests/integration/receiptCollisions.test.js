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

const request = supertest(app);
const LF = String.fromCharCode(10);
const HEADER = 'Receipt,Date,Time,Items,Total';
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const importLines = async (token, lines, name, { columnMapping = MAPPING, itemsMode = 'packed' } = {}) => {
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

// UAT-00 F17 same-receipt-two-sales.csv: register numbering restarted at the afternoon shift.
const F17 = [
  HEADER,
  '0001,2026-09-14,08:05,1 x Flat White,38.00',
  '0002,2026-09-14,08:20,1 x Muffin,30.00',
  '0001,2026-09-14,14:40,2 x Latte,84.00',
];

describe('a receipt number shared by two different sales', () => {
  let token;
  beforeEach(async () => {
    ({ token } = await createTestUser());
  });

  it('imports both sales when the number repeats later in the day with a different basket', async () => {
    const res = await importLines(token, F17, 'same-receipt-two-sales.csv');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ imported: 3, skipped: 0, errors: 0 });
    const totals = (await Transaction.find({ receiptId: '0001' }).lean()).map((row) => row.total).sort((a, b) => a - b);
    expect(totals).toEqual([38, 84]);
  });

  it('still treats an identical re-upload as already imported', async () => {
    await importLines(token, F17, 'same-receipt-two-sales.csv');
    const again = await importLines(token, F17, 'same-receipt-two-sales (again).csv');
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/every valid row already exists/i);
  });

  it('names a contradiction at the same minute instead of counting it as a duplicate', async () => {
    const res = await importLines(token, [
      HEADER,
      '0007,2026-09-14,09:00,1 x Flat White,38.00',
      '0007,2026-09-14,09:00,1 x Scone,32.00',
    ], 'same-minute.csv');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ imported: 1, skipped: 0, errors: 1 });
    expect(res.body.rowErrors.map((error) => error.reason)).toEqual([
      expect.stringMatching(/^Receipt 0007 appears twice on 2026-09-14 at 09:00 with different contents \(R38\.00 and R32\.00\)/),
    ]);
  });

  it('treats a different basket at the same minute and total as a contradiction, not a duplicate', async () => {
    const res = await importLines(token, [
      HEADER,
      '0003,2026-09-14,11:00,1 x Latte,38.00',
      '0003,2026-09-14,11:00,1 x Cappuccino,38.00',
    ], 'same-money-other-items.csv');
    expect(res.body.stats).toMatchObject({ imported: 1, skipped: 0, errors: 1 });
  });

  it('compares against sales already stored, not only within the file', async () => {
    await importLines(token, [HEADER, '0009,2026-09-14,09:00,1 x Flat White,38.00'], 'first.csv');
    const res = await importLines(token, [
      HEADER,
      '0009,2026-09-14,09:00,1 x Flat White,45.00',
      '0009,2026-09-14,16:10,1 x Brownie,32.00',
    ], 'second.csv');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ imported: 1, skipped: 0, errors: 1 });
    expect(res.body.rowErrors[0].reason).toMatch(/^Receipt 0009 appears twice on 2026-09-14 at 09:00/);
    expect(await Transaction.countDocuments({ receiptId: '0009' })).toBe(2);
  });

  it('names the contradiction when it is the only thing a file holds, instead of blaming the mapping', async () => {
    await importLines(token, [HEADER, '0009,2026-09-14,09:00,1 x Flat White,38.00'], 'first.csv');
    const res = await importLines(token, [HEADER, '0009,2026-09-14,09:00,1 x Flat White,45.00'], 'edited.csv');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/^No new transactions were imported\. Receipt 0009 appears twice on 2026-09-14 at 09:00/);
    expect(await Transaction.countDocuments({ receiptId: '0009' })).toBe(1);
  });

  it('refuses receipt numbers Excel turned into scientific notation, naming why', async () => {
    const res = await importLines(token, [
      HEADER,
      '2.02609E+16,2026-09-14,09:00,1 x Flat White,38.00',
      '2.02609E+16,2026-09-14,09:05,1 x Muffin,30.00',
      '1001,2026-09-14,09:10,1 x Scone,32.00',
    ], 'excel-mangled.csv');
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ imported: 1, skipped: 0, errors: 2 });
    expect(res.body.rowErrors.map((error) => error.reason)).toEqual([
      expect.stringMatching(/scientific notation/),
      expect.stringMatching(/scientific notation/),
    ]);
  });

  it('reports a line-per-row number reused later in the day as a named error, never a duplicate', async () => {
    const res = await importLines(token, [
      'Receipt,Date,Time,Item,Qty,Line Total',
      '0001,2026-09-14,08:05,Flat White,1,38.00',
      '0002,2026-09-14,08:20,Muffin,1,30.00',
      '0001,2026-09-14,14:40,Latte,2,84.00',
    ], 'line-per-row-reused.csv', {
      columnMapping: { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Item', quantity: 'Qty', total: 'Line Total' },
      itemsMode: 'line-per-row',
    });
    expect(res.status).toBe(200);
    expect(res.body.stats.skipped).toBe(0);
    expect(res.body.rowErrors.map((error) => error.reason).join(' ')).toMatch(/Receipt 0001 was dropped/);
  });
});
