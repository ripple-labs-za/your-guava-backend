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

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const request = supertest(app);
const MAP = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const importCsv = async (token, lines, name) => {
  const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(['Receipt,Date,Time,Items,Total', ...lines].join('\n')), name);
  return request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
    .send({ columnMapping: MAP, itemsMode: 'packed' });
};
const sum = (object) => Object.values(object || {}).reduce((total, value) => total + value, 0);

describe('every skipped row has a reason', () => {
  let token;
  beforeEach(async () => { ({ token } = await createTestUser()); });

  it('names rows already imported by an earlier upload', async () => {
    await importCsv(token, ['A1,2026-09-01,09:00,1 x Latte,38.00', 'A2,2026-09-01,09:05,1 x Latte,38.00'], 'first.csv');
    const second = await importCsv(token, ['A2,2026-09-01,09:05,1 x Latte,38.00', 'A3,2026-09-01,09:10,1 x Scone,28.00'], 'second.csv');
    expect(second.status).toBe(200);
    expect(second.body.stats).toMatchObject({ imported: 1, skipped: 1, skippedByReason: { duplicate: 1 } });
    const stored = await request.get(`/api/uploads/${second.body.uploadId}`).set('Authorization', `Bearer ${token}`);
    expect(stored.body.upload.stats.skippedByReason).toEqual({ duplicate: 1 });
  });

  it('names a sale repeated inside one file', async () => {
    const done = await importCsv(token, ['B1,2026-09-01,09:00,1 x Latte,38.00', 'B1,2026-09-01,09:00,1 x Latte,38.00', 'B2,2026-09-01,09:05,1 x Tea,25.00'], 'repeat.csv');
    expect(done.body.stats).toMatchObject({ imported: 2, skipped: 1, skippedByReason: { in_file_duplicate: 1 } });
  });

  it('keeps skipped equal to the sum of its reasons', async () => {
    await importCsv(token, ['C1,2026-09-01,09:00,1 x Latte,38.00'], 'c1.csv');
    const header = 'Receipt,Date,Time,Status,Items,Total';
    const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from([header, 'C1,2026-09-01,09:00,Approved,1 x Latte,38.00', 'C2,2026-09-01,09:05,Declined,1 x Tea,25.00',
        'C3,2026-09-01,09:10,Approved,1 x Tea,25.00', 'C3,2026-09-01,09:10,Approved,1 x Tea,25.00'].join('\n')), 'mixed.csv');
    const done = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: { ...MAP, status: 'Status' }, itemsMode: 'packed' });
    expect(done.body.stats.skipped).toBe(3);
    expect(sum(done.body.stats.skippedByReason)).toBe(done.body.stats.skipped);
  });
});
