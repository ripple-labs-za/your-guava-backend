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
const DAY_MS = 24 * 60 * 60 * 1000;
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  delete process.env.UPLOAD_READMIT_SYNC_MAX_UPLOADS;
  mockR2Files.clear();
  await clearDB();
});

const daysBetween = (from, to) => {
  const days = [];
  const last = new Date(`${to}T00:00:00Z`).getTime();
  for (let at = new Date(`${from}T00:00:00Z`).getTime(); at <= last; at += DAY_MS) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
};

// Mirrors UAT-00 F15/F16: two sales a day, receipt numbers unique within a day.
const salesCsv = (from, to, { extraHeader = '', extraCell = () => '' } = {}) => [
  `Receipt,Date,Time,Items,Total${extraHeader}`,
  ...daysBetween(from, to).flatMap((day) => [
    `R-${day}-1,${day},09:15,1 x Flat White,38.00${extraCell(day, 38)}`,
    `R-${day}-2,${day},11:40,2 x Muffin,60.00${extraCell(day, 60)}`,
  ]),
].join(LF);

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
  expect(done.status).toBe(200);
  return { uploadId: staged.body.uploadId, stats: done.body.stats };
};

// Cafe-local (Africa/Johannesburg, the default) day bounds.
const countDays = (cafeId, from, to) => Transaction.countDocuments({
  cafeId,
  date: { $gte: new Date(`${from}T00:00:00+02:00`), $lte: new Date(`${to}T23:59:59+02:00`) },
});

describe('deleting or remapping an upload never drops rows another upload holds', () => {
  it('re-admits from the later upload the rows it held only through the deleted one', async () => {
    const { token, user } = await createTestUser();
    const a = await importFile(token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
    const b = await importFile(token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');
    expect(a.stats.imported).toBe(62);
    expect(b.stats.imported).toBe(30); // 15-31 Jan were already held under A

    const res = await request.delete(`/api/uploads/${a.uploadId}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.readmitted).toEqual({
      rows: 34,
      uploads: [{ uploadId: b.uploadId, fileName: 'overlap-b.csv', rows: 34 }],
    });
    expect(res.body.readmissionQueued).toEqual([]);
    expect(await countDays(user.activeCafeId, '2026-01-15', '2026-01-31')).toBe(34);
    expect(await countDays(user.activeCafeId, '2026-01-01', '2026-01-14')).toBe(0);
    expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(64);
    expect(await Transaction.countDocuments({ uploadId: b.uploadId })).toBe(64);
    expect((await Upload.findById(b.uploadId).lean()).stats.imported).toBe(64);
  });

  // BE-03-T09: skipped is always the sum of its reasons, so re-admitted rows leave the duplicate count with it.
  it('keeps skipped equal to the sum of its reasons after re-admitting rows', async () => {
    const { token } = await createTestUser();
    const a = await importFile(token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
    const b = await importFile(token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');
    expect(b.stats).toMatchObject({ skipped: 34, skippedByReason: { duplicate: 34 } });

    await request.delete(`/api/uploads/${a.uploadId}`).set('Authorization', `Bearer ${token}`);

    const { stats } = await Upload.findById(b.uploadId).lean();
    expect(stats).toMatchObject({ imported: 64, skipped: 0, skippedByReason: { duplicate: 0 } });
  });

  it('lists the uploads that share days with the one about to be deleted', async () => {
    const { token } = await createTestUser();
    const a = await importFile(token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
    const b = await importFile(token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');
    await importFile(token, salesCsv('2026-03-01', '2026-03-05'), 'march.csv');

    const res = await request.get(`/api/uploads/${a.uploadId}/overlaps`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.overlaps).toEqual([
      { uploadId: b.uploadId, fileName: 'overlap-b.csv', firstDateKey: '2026-01-15', lastDateKey: '2026-02-15' },
    ]);
    expect(res.body.more).toBe(0);
  });

  it("never lists or re-reads another cafe's overlapping upload", async () => {
    const owner = await createTestUser();
    const other = await createTestUser({ email: 'other-owner@yourguava.com' });
    const a = await importFile(owner.token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
    await importFile(other.token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');

    const foreign = await request.get(`/api/uploads/${a.uploadId}/overlaps`).set('Authorization', `Bearer ${other.token}`);
    expect(foreign.status).toBe(404);
    const listed = await request.get(`/api/uploads/${a.uploadId}/overlaps`).set('Authorization', `Bearer ${owner.token}`);
    expect(listed.body.overlaps).toEqual([]);

    const res = await request.delete(`/api/uploads/${a.uploadId}`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.body.readmitted).toEqual({ rows: 0, uploads: [] });
    expect(await Transaction.countDocuments({ cafeId: owner.user.activeCafeId })).toBe(0);
    expect(await Transaction.countDocuments({ cafeId: other.user.activeCafeId })).toBe(64);
  });

  it('re-admits from the overlapping upload what a remap no longer imports', async () => {
    const { token, user } = await createTestUser();
    const withNet = salesCsv('2026-01-01', '2026-01-31', {
      extraHeader: ',Net',
      extraCell: (day, total) => (day >= '2026-01-20' ? ',' : `,${total.toFixed(2)}`),
    });
    const a = await importFile(token, withNet, 'overlap-a.csv');
    const b = await importFile(token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');
    expect(b.stats.imported).toBe(30);

    const res = await request
      .patch(`/api/uploads/${a.uploadId}/mapping`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: { ...MAPPING, total: 'Net' }, itemsMode: 'packed', allowPartialImport: true });

    expect(res.status).toBe(200);
    expect(res.body.stats.imported).toBe(38); // 1-19 Jan; Net is blank from 20 Jan
    expect(res.body.readmitted.rows).toBe(24); // 20-31 Jan, which B held only through A
    expect(res.body.readmitted.uploads[0].fileName).toBe('overlap-b.csv');
    expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(92); // 46 days, twice
  });

  it('re-reads the overlapping upload on the maintenance queue when the request budget is spent', async () => {
    process.env.UPLOAD_READMIT_SYNC_MAX_UPLOADS = '0';
    const { token, user } = await createTestUser();
    const a = await importFile(token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
    const b = await importFile(token, salesCsv('2026-01-15', '2026-02-15'), 'overlap-b.csv');

    const res = await request.delete(`/api/uploads/${a.uploadId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.readmitted).toEqual({ rows: 0, uploads: [] });
    expect(res.body.readmissionQueued).toEqual([{ uploadId: b.uploadId, fileName: 'overlap-b.csv' }]);

    // The delete kicks the queue in the background; wait for the whole job (re-admission, then the forecast
    // steps that follow it), not for a fixed time, so nothing is still writing when afterEach clears the DB.
    let stored;
    const deadline = Date.now() + 10000;
    do {
      stored = await Upload.findById(b.uploadId).lean();
      const jobFinished = ['completed', 'partial_failure'].includes(stored.maintenance?.status);
      if (stored.readmission?.status === 'completed' && jobFinished) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    expect(stored.readmission).toMatchObject({
      status: 'completed', rows: 34, firstDateKey: '2026-01-01', lastDateKey: '2026-01-31',
    });
    expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(64);
  });

  it('re-admits nothing and changes nothing else when no other upload shares the days', async () => {
    const { token, user } = await createTestUser();
    const a = await importFile(token, salesCsv('2026-01-01', '2026-01-31'), 'overlap-a.csv');
    await importFile(token, salesCsv('2026-03-01', '2026-03-05'), 'march.csv');

    const res = await request.delete(`/api/uploads/${a.uploadId}`).set('Authorization', `Bearer ${token}`);
    expect(res.body).toEqual({ success: true, readmitted: { rows: 0, uploads: [] }, readmissionQueued: [] });
    expect(await Transaction.countDocuments({ cafeId: user.activeCafeId })).toBe(10);
  });
});
