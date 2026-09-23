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
const CRLF = String.fromCharCode(13, 10);
const MAPPING = { date: 'Date', time: 'Time', items: 'Items', total: 'Total' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const days = (from, to) => {
  const out = [];
  for (let day = from; day <= to; day += 1) out.push(`2026-09-${String(day).padStart(2, '0')}`);
  return out;
};
// Two sales a day; on 10 Sep two identical flat whites were rung up in the same minute.
const salesOn = (day) => [
  { day, time: '09:10', items: '1 x Flat White', total: '38.00' },
  ...(day === '2026-09-10' ? [{ day, time: '09:10', items: '1 x Flat White', total: '38.00' }] : []),
  { day, time: '12:30', items: '1 x Toasted Sandwich', total: '65.00' },
];
// UAT-00 F13 receiptless-a.csv: 1-14 Sep, plain layout.
const fileA = (eol = LF) => ['Date,Time,Items,Total',
  ...days(1, 14).flatMap(salesOn).map((s) => `${s.day},${s.time},${s.items},${s.total}`)].join(eol);
// UAT-00 F14 receiptless-b.csv: 8-21 Sep, other column order, every field quoted.
const fileB = () => ['"Total","Items","Date","Time"',
  ...days(8, 21).flatMap(salesOn).map((s) => `"${s.total}","${s.items}","${s.day}","${s.time}"`)].join(LF);

const importFile = async (token, text, name) => {
  const staged = await request
    .post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(text), name);
  expect(staged.status).toBe(200);
  const done = await request
    .post(`/api/uploads/${staged.body.uploadId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ columnMapping: MAPPING, itemsMode: 'packed' });
  return { uploadId: staged.body.uploadId, res: done };
};

const onDay = (cafeId, day) => Transaction.countDocuments({
  cafeId, date: { $gte: new Date(`${day}T00:00:00+02:00`), $lte: new Date(`${day}T23:59:59+02:00`) },
});

describe('receipt-less exports are identified by what was sold, not by which file carried it', () => {
  it('imports the overlap of two differently laid-out exports once, and says so', async () => {
    const { token, user } = await createTestUser();
    const a = await importFile(token, fileA(), 'receiptless-a.csv');
    expect(a.res.body.stats.imported).toBe(29);

    const b = await importFile(token, fileB(), 'receiptless-b.csv');

    expect(b.res.status).toBe(200);
    expect(b.res.body.stats.imported).toBe(14); // 15-21 Sep
    expect(b.res.body.overlap).toEqual({
      rows: 15,
      uploads: [{ uploadId: a.uploadId, fileName: 'receiptless-a.csv', rows: 15 }],
    });
    expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(43);
    expect(await onDay(user.activeCafeId, '2026-09-10')).toBe(3);
  });

  it('keeps identical sales rung up in the same minute, by counting them', async () => {
    const { token, user } = await createTestUser();
    await importFile(token, fileA(), 'receiptless-a.csv');
    expect(await onDay(user.activeCafeId, '2026-09-10')).toBe(3);

    const three = ['Date,Time,Items,Total', ...[1, 2, 3].map(() => '2026-09-10,09:10,1 x Flat White,38.00')].join(LF);
    const c = await importFile(token, three, 'three-flat-whites.csv');

    expect(c.res.status).toBe(200);
    expect(c.res.body.stats.imported).toBe(1); // A already holds two of the three
    expect(await onDay(user.activeCafeId, '2026-09-10')).toBe(4);
  });

  it('recognises the same export re-saved with Windows line endings', async () => {
    const { token } = await createTestUser();
    await importFile(token, fileA(), 'receiptless-a.csv');
    const again = await importFile(token, fileA(CRLF), 'receiptless-a (resaved).csv');
    expect(again.res.status).toBe(409);
    expect(again.res.body.message).toMatch(/every valid row already exists/i);
  });

  it('re-admits the right count after the older export is deleted', async () => {
    const { token, user } = await createTestUser();
    const a = await importFile(token, fileA(), 'receiptless-a.csv');
    await importFile(token, fileB(), 'receiptless-b.csv');
    const res = await request.delete(`/api/uploads/${a.uploadId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(29); // all of B, nothing twice
    expect(await onDay(user.activeCafeId, '2026-09-10')).toBe(3);
  });

  it('lets a remap of the later export keep only what it adds', async () => {
    const { token } = await createTestUser();
    await importFile(token, fileA(), 'receiptless-a.csv');
    const b = await importFile(token, fileB(), 'receiptless-b.csv');
    const res = await request
      .patch(`/api/uploads/${b.uploadId}/mapping`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: MAPPING, itemsMode: 'packed' });
    expect(res.status).toBe(200);
    expect(res.body.stats.imported).toBe(14);
  });

  it('never commits the overlap twice when both exports are confirmed at once', async () => {
    const { token, user } = await createTestUser();
    const stage = async (text, name) => (await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(text), name)).body.uploadId;
    const confirm = (uploadId) => request
      .post(`/api/uploads/${uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: MAPPING, itemsMode: 'packed' });
    const ids = [await stage(fileA(), 'receiptless-a.csv'), await stage(fileB(), 'receiptless-b.csv')];

    const results = await Promise.all(ids.map(confirm));

    const imported = results.filter((r) => r.status === 200).reduce((sum, r) => sum + r.body.stats.imported, 0);
    const total = await Transaction.countDocuments({ cafeId: user.activeCafeId });
    expect(total).toBe(imported); // every stored row is one a confirm reported, and no response hid a write
    expect([29, 43]).toContain(total); // one file, or both with the overlap once
    expect(await onDay(user.activeCafeId, '2026-09-10')).toBe(3);
    for (const r of results) expect([200, 409, 500]).toContain(r.status);
  });

  it('matches sales stored under the old file-scoped keys', async () => {
    const { token, user } = await createTestUser();
    await Transaction.create({
      cafeId: user.activeCafeId,
      dedupKey: 'a'.repeat(64), // a source-v1 key from before this card
      date: new Date('2026-09-01T07:10:00.000Z'),
      hour: 9,
      dayOfWeek: 2,
      status: 'approved',
      items: [{ name: 'Flat White', quantity: 1, unitPrice: 38 }],
      total: 38,
    });
    const two = ['Date,Time,Items,Total', '2026-09-01,09:10,1 x Flat White,38.00', '2026-09-01,12:30,1 x Toasted Sandwich,65.00']
      .join(LF);
    const res = (await importFile(token, two, 'legacy-overlap.csv')).res;
    expect(res.status).toBe(200);
    expect(res.body.stats.imported).toBe(1);
    expect(res.body.overlap).toEqual({ rows: 1, uploads: [{ uploadId: null, fileName: null, rows: 1 }] });
  });
});
