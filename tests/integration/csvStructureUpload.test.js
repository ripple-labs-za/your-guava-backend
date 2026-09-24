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

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const request = supertest(app);
const MAP = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const stage = (token, buffer, name) => request.post('/api/transactions/upload')
  .set('Authorization', `Bearer ${token}`).attach('file', buffer, name);
const confirm = (token, uploadId, columnMapping) => request.post(`/api/uploads/${uploadId}/confirm`)
  .set('Authorization', `Bearer ${token}`).send({ columnMapping, itemsMode: 'packed' });

describe('till exports with real-world encodings and layouts import end to end', () => {
  let token;
  beforeEach(async () => { ({ token } = await createTestUser()); });

  it('auto-detects a Yoco export whose quoted headers sit behind a BOM, receipt column included', async () => {
    const header = ['Receipt', 'Date', 'Time', 'Status', 'Payment Method', 'Order Number', 'Card Reader', 'Items', 'Note', 'Currency', 'Tip', 'Discount', 'VAT', 'Total (incl. tax)', 'Fee Amount', 'Net Amount'];
    const row = ['2026/09/000001', '2026/09/01', '09:30:00', 'Approved', 'Card', '#1', '1', '1 x Flat White', '', 'ZAR', '0', '0', '0', '38.0', '1', '37'];
    const quoted = (cells) => cells.map((cell) => `"${cell}"`).join(',');
    const file = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${quoted(header)}\n${quoted(row)}\n`)]);
    const staged = await stage(token, file, 'yoco-bom.csv');
    expect(staged.status).toBe(200);
    expect(staged.body.posType).toBe('yoco');
    expect(staged.body.columnMapping.receiptId).toBe('Receipt');
  });

  it('imports a Windows-1252 file with its accents and quantities', async () => {
    const text = 'Receipt,Date,Time,Items,Total\nW1,2026-09-01,09:00,2 \u00d7 Cr\u00e8me br\u00fbl\u00e9e,90.00\n';
    const staged = await stage(token, Buffer.from([...text].map((ch) => ch.charCodeAt(0))), 'windows-1252.csv');
    const done = await confirm(token, staged.body.uploadId, MAP);
    expect(done.status).toBe(200);
    const [tx] = await Transaction.find({ uploadId: staged.body.uploadId }).lean();
    expect(tx.items[0]).toMatchObject({ name: 'Crème brûlée', quantity: 2 });
  });

  it('stages a report with title lines under its real headings and imports every row', async () => {
    const text = ['Sales Report', 'From 01/09/2026 to 14/09/2026', '', 'Receipt;Date;Time;Items;Total', 'T1;2026-09-01;09:00;1 x Latte;38,00', '', 'T2;2026-09-01;09:30;1 x Muffin;30,00'].join('\n');
    const staged = await stage(token, Buffer.from(text), 'report.csv');
    expect(staged.body.headers).toEqual(['Receipt', 'Date', 'Time', 'Items', 'Total']);
    const done = await confirm(token, staged.body.uploadId, MAP);
    expect(done.body.stats).toMatchObject({ imported: 2, errors: 0, totalRows: 2 });
  });

  it('tells the owner to delete title lines when no heading row can be found', async () => {
    const staged = await stage(token, Buffer.from('Sales Report\nTotals only\n1234\n'), 'title-only.csv');
    expect(staged.status).toBe(400);
    expect(staged.body.message).toMatch(/column headings/);
  });
});
