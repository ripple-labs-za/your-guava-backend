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

const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const readmission = require('../../src/services/readmission.service');

const request = supertest(app);
const LF = String.fromCharCode(10);
const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = 'Africa/Johannesburg';
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
  const done = await request.post(`/api/uploads/${staged.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`)
    .send({ columnMapping: MAPPING, itemsMode: 'packed' });
  expect(done.status).toBe(200);
  return staged.body.uploadId;
};

// Prepares B's re-read, lets `between` touch B, deletes A's rows and applies the re-read in one transaction.
const deleteAWith = async (between) => {
  const { token, user } = await createTestUser();
  const cafeId = user.activeCafeId;
  const a = await importFile(token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
  const b = await importFile(token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');
  const plan = await readmission.prepareReadmission({
    cafeId, range: { firstDateKey: '2026-01-01', lastDateKey: '2026-01-31' }, excludeUploadId: a, timezone: ZONE,
  });
  expect(plan.prepared).toHaveLength(1);
  await between(b);
  let outcome;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Transaction.deleteMany({ cafeId, uploadId: a }).session(session);
      outcome = await readmission.applyReadmission({ prepared: plan.prepared, cafeId, session, timezone: ZONE });
    });
  } finally {
    await session.endSession();
  }
  return outcome;
};

describe('re-admission treats an upload as changed only when its committed content changed (BE-03-T02)', () => {
  it('still re-admits when only the overlapping upload\'s background maintenance wrote to it meanwhile', async () => {
    const outcome = await deleteAWith((b) => Upload.updateOne(
      { _id: b }, { $set: { 'maintenance.status': 'completed', 'maintenance.completedAt': new Date() } }
    ));
    expect(outcome.stale).toHaveLength(0);
    expect(outcome.applied.map((entry) => entry.rows)).toEqual([34]);
  });

  it('defers to the queue when the overlapping upload was re-committed or is being re-parsed meanwhile', async () => {
    const recommitted = await deleteAWith((b) => Upload.updateOne({ _id: b }, { $set: { completedAt: new Date(Date.now() + 1000) } }));
    expect(recommitted.stale).toHaveLength(1);
    expect(recommitted.applied).toEqual([]);
    await clearDB();
    const parsing = await deleteAWith((b) => Upload.updateOne({ _id: b }, { $set: { status: 'parsing' } }));
    expect(parsing.stale).toHaveLength(1);
  });
});
