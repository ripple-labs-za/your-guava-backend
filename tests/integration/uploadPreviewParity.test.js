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
const Upload = require('../../src/models/Upload.model');

const request = supertest(app);
const LF = String.fromCharCode(10);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const stage = (token, text, name) => request
  .post('/api/transactions/upload')
  .set('Authorization', `Bearer ${token}`)
  .attach('file', Buffer.from(text), name);

const confirm = (token, uploadId, columnMapping) => request
  .post(`/api/uploads/${uploadId}/confirm`)
  .set('Authorization', `Bearer ${token}`)
  .send({ columnMapping, itemsMode: 'packed' });

// Mirrors UAT-00 F04 duplicate-headers.csv: gross Total, then net Total.
const DUPLICATE_TOTALS = [
  'Receipt,Date,Time,Items,Total,Total',
  'D1,2026-09-14,09:00,1 x Latte,100.00,86.96',
  'D2,2026-09-14,10:00,2 x Muffin,60.00,52.17',
].join(LF);

describe('the upload preview reads a CSV exactly as the import does', () => {
  let token;
  beforeEach(async () => {
    ({ token } = await createTestUser());
  });

  it('imports an Excel sep=; export end to end through /upload then /confirm', async () => {
    // Mirrors UAT-00 F03 excel-sep-semicolon.csv: directive line, ';' separator, decimal commas.
    const text = [
      'sep=;',
      'Sale Date;Sale Time;Description;Amount',
      '2026-09-14;09:30;1 x Flat White;R 35,00',
      '2026-09-14;10:05;1 x Toasted Sandwich;R 42,50',
    ].join(LF);

    const staged = await stage(token, text, 'excel-sep-semicolon.csv');
    expect(staged.status).toBe(200);
    expect(staged.body.headers).toEqual(['Sale Date', 'Sale Time', 'Description', 'Amount']);
    expect(staged.body.preview[0]).toMatchObject({ Description: '1 x Flat White', Amount: 'R 35,00' });

    const done = await confirm(token, staged.body.uploadId, {
      date: 'Sale Date', time: 'Sale Time', items: 'Description', total: 'Amount',
    });
    expect(done.status).toBe(200);
    expect(done.body.stats.imported).toBe(2);
    const totals = (await Transaction.find({ uploadId: staged.body.uploadId }).lean())
      .map((row) => row.total)
      .sort((a, b) => a - b);
    expect(totals).toEqual([35, 42.5]);
  });

  it('offers Total (2) and imports the net column the owner chose', async () => {
    const staged = await stage(token, DUPLICATE_TOTALS, 'duplicate-headers.csv');
    expect(staged.status).toBe(200);
    expect(staged.body.headers).toEqual(['Receipt', 'Date', 'Time', 'Items', 'Total', 'Total (2)']);
    expect(staged.body.preview[0]).toMatchObject({ Total: '100.00', 'Total (2)': '86.96' });
    expect((await Upload.findById(staged.body.uploadId).lean()).headers).toContain('Total (2)');

    const done = await confirm(token, staged.body.uploadId, {
      receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total (2)',
    });
    expect(done.status).toBe(200);
    const byReceipt = Object.fromEntries(
      (await Transaction.find({ uploadId: staged.body.uploadId }).lean()).map((row) => [row.receiptId, row.total])
    );
    expect(byReceipt).toEqual({ D1: 86.96, D2: 52.17 });
  });

  it('imports the gross column when the owner chose Total, the value the preview showed under Total', async () => {
    const staged = await stage(token, DUPLICATE_TOTALS, 'duplicate-headers.csv');
    // Before the fix the preview showed the NET value under "Total" while the import read the gross one.
    expect(staged.body.preview[0].Total).toBe('100.00');
    const done = await confirm(token, staged.body.uploadId, {
      receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total',
    });
    expect(done.status).toBe(200);
    const byReceipt = Object.fromEntries(
      (await Transaction.find({ uploadId: staged.body.uploadId }).lean()).map((row) => [row.receiptId, row.total])
    );
    expect(byReceipt).toEqual({ D1: 100, D2: 60 });
  });
});
