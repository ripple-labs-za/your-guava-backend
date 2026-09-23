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
const DAY_MS = 24 * 60 * 60 * 1000;
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

const salesCsv = (from, to) => {
  const lines = ['Receipt,Date,Time,Items,Total'];
  for (let at = new Date(`${from}T00:00:00Z`).getTime(); at <= new Date(`${to}T00:00:00Z`).getTime(); at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    lines.push(`R-${day}-1,${day},09:15,1 x Flat White,38.00`, `R-${day}-2,${day},11:40,2 x Muffin,60.00`);
  }
  return lines.join(LF);
};

const importFile = async (token, text, name) => {
  const staged = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(text), name);
  expect(staged.status).toBe(200);
  const done = await request.post(`/api/uploads/${staged.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
    .send({ columnMapping: MAPPING, itemsMode: 'packed' });
  expect(done.status).toBe(200);
  return staged.body.uploadId;
};

// BE-03-T02 review focus: a second cafe in the SAME organisation, with its own overlapping upload, is neither listed as
// an overlap nor re-read when the first cafe's upload is deleted.
it("never lists or re-reads a sibling cafe's overlapping upload in the same organisation (BE-03-T02)", async () => {
  const owner = await createTestUser({ email: 'two-cafe-overlap@yourguava.com' });
  const cafeA = String(owner.user.activeCafeId);
  const added = await request.post('/api/team/add-cafe').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Cafe B' });
  expect(added.status).toBe(201);
  const cafeB = String(added.body.cafe._id);

  const uploadA = await importFile(owner.token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
  const switched = await request.post('/api/team/switch-cafe').set('Authorization', `Bearer ${owner.token}`).send({ cafeId: cafeB });
  expect(switched.status).toBe(200);
  await importFile(switched.body.accessToken, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');

  const listed = await request.get(`/api/uploads/${uploadA}/overlaps`).set('Authorization', `Bearer ${owner.token}`);
  expect(listed.status).toBe(200);
  expect(listed.body.overlaps).toEqual([]);

  const res = await request.delete(`/api/uploads/${uploadA}`).set('Authorization', `Bearer ${owner.token}`);
  expect(res.status).toBe(200);
  expect(res.body.readmitted).toEqual({ rows: 0, uploads: [] });
  expect(res.body.readmissionQueued).toEqual([]);
  expect(await Transaction.countDocuments({ cafeId: cafeA })).toBe(0);
  expect(await Transaction.countDocuments({ cafeId: cafeB })).toBe(64);
});
