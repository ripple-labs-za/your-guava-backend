const mockR2Files = new Map();
const mockR2ContentTypes = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key, contentType) => { mockR2Files.set(key, buffer); mockR2ContentTypes.set(key, contentType); },
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

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const Upload = require('../../src/models/Upload.model');
const Item = require('../../src/models/Item.model');
const r2 = require('../../src/services/r2.service');
const { cleanupAbandonedPendingUploads } = require('../../src/controllers/uploads.controller');

const request = supertest(app);
const MAP = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
const csv = (...rows) => Buffer.from(['Receipt,Date,Time,Items,Total', ...rows].join('\n'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 24 * 3600 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => { jest.restoreAllMocks(); mockR2Files.clear(); mockR2ContentTypes.clear(); await clearDB(); });

const auth = (req, token) => req.set('Authorization', `Bearer ${token}`);
const stage = (token, buffer, name = 'sales.csv') => auth(request.post('/api/transactions/upload'), token).attach('file', buffer, name);
const confirm = (token, uploadId, extra = {}) => auth(request.post(`/api/uploads/${uploadId}/confirm`), token)
  .send({ columnMapping: MAP, itemsMode: 'packed', ...extra });
// Writes updatedAt as given; Mongoose timestamps would overwrite it on save. The raw driver does not cast, so the id is
// made an ObjectId (the plan's string id matched nothing).
const age = (uploadId, ms, set = {}) => Upload.collection.updateOne(
  { _id: new mongoose.Types.ObjectId(String(uploadId)) }, { $set: { updatedAt: new Date(Date.now() - ms), ...set } });

describe('a menu edit and an import on one cafe cannot interleave', () => {
  it('keeps the import\'s item totals when a menu edit\'s rebuild started before the import committed', async () => {
    const { token, user } = await createTestUser();
    const cafeId = user.activeCafeId;
    const first = await stage(token, csv('L1,2026-09-01,09:00,1 x Latte,38.00'));
    await confirm(token, first.body.uploadId);
    const latte = await Item.findOne({ cafeId, name: 'Latte' }).lean();
    const second = await stage(token, csv('L2,2026-09-02,09:00,2 x Latte,76.00', 'L3,2026-09-02,09:05,1 x Scone,28.00'));

    // Hold the edit's rebuild between reading sales stats and writing items, until the import has committed (or 1.5 s).
    let importCommitted; const committed = new Promise((resolve) => { importCommitted = resolve; });
    const aggregate = Transaction.aggregate.bind(Transaction);
    const spy = jest.spyOn(Transaction, 'aggregate').mockImplementationOnce((pipeline) => {
      const query = aggregate(pipeline);
      const exec = query.exec.bind(query);
      query.exec = async (...args) => { const result = await exec(...args); await Promise.race([committed, sleep(1500)]); return result; };
      return query;
    }).mockImplementation(aggregate);

    const edit = auth(request.put(`/api/items/${latte._id}`), token).send({ aliases: ['LATTE REG'] }).then((res) => res);
    while (spy.mock.calls.length === 0) await sleep(10); // the edit's rebuild has read its stats
    const imported = confirm(token, second.body.uploadId).then((res) => { importCommitted(); return res; });
    const [editRes, importRes] = await Promise.all([edit, imported]);

    expect(editRes.status).toBe(200);
    expect(importRes.status).toBe(200);
    expect((await Item.findOne({ cafeId, name: 'Latte' }).lean()).totalSold).toBe(3);
    expect((await Item.findOne({ cafeId, name: 'Scone' }).lean()).totalSold).toBe(1);
  });
});

describe('confirm replay', () => {
  it('answers 409 UPLOAD_CHANGED, not 500, when the upload changed under the replay', async () => {
    const { token } = await createTestUser();
    const staged = await stage(token, csv('C1,2026-09-01,09:00,1 x Latte,38.00'));
    expect((await confirm(token, staged.body.uploadId)).status).toBe(200);
    jest.spyOn(Upload, 'findOneAndUpdate').mockResolvedValueOnce(null); // a remap took the lock, or a delete committed
    const replay = await confirm(token, staged.body.uploadId);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ success: false, code: 'UPLOAD_CHANGED' });
  });
});

describe('the sweeper', () => {
  it('recovers an upload left "parsing" by a crash, as failed when it never completed', async () => {
    const { token } = await createTestUser();
    const staged = await stage(token, csv('S1,2026-09-01,09:00,1 x Latte,38.00'));
    await age(staged.body.uploadId, 2 * 3600 * 1000, { status: 'parsing' });
    const summary = await cleanupAbandonedPendingUploads();
    expect(summary.recoveredParsing).toBe(1);
    expect((await Upload.findById(staged.body.uploadId).lean())).toMatchObject({ status: 'failed', errorMessage: expect.stringMatching(/did not finish/) });
  });

  it('recovers a completed upload interrupted during a remap back to completed', async () => {
    const { token } = await createTestUser();
    const staged = await stage(token, csv('S2,2026-09-01,09:00,1 x Latte,38.00'));
    await confirm(token, staged.body.uploadId);
    await age(staged.body.uploadId, 2 * 3600 * 1000, { status: 'parsing' });
    await cleanupAbandonedPendingUploads();
    expect((await Upload.findById(staged.body.uploadId).lean()).status).toBe('completed');
  });

  it('expires a failed upload after the retention window, deleting its stored file first', async () => {
    const { token } = await createTestUser();
    const staged = await stage(token, csv('F1,2026-09-01,09:00,1 x Latte,38.00'));
    const { r2Key } = await Upload.findById(staged.body.uploadId).lean();
    await age(staged.body.uploadId, 8 * DAY, { status: 'failed', errorMessage: 'No valid transaction rows could be imported with this mapping' });
    const summary = await cleanupAbandonedPendingUploads();
    expect(summary.expiredFailed).toBe(1);
    expect(mockR2Files.has(r2Key)).toBe(false);
    expect((await Upload.findById(staged.body.uploadId).lean()).status).toBe('deleted');
  });

  it('leaves a recent failed upload, and never expires one that holds transactions', async () => {
    const { token, user } = await createTestUser();
    const recent = await stage(token, csv('F2,2026-09-01,09:00,1 x Latte,38.00'));
    await age(recent.body.uploadId, 2 * DAY, { status: 'failed' });
    const holding = await stage(token, csv('F3,2026-09-01,09:00,1 x Latte,38.00'));
    await Transaction.create({ cafeId: user.activeCafeId, uploadId: holding.body.uploadId, receiptId: 'F3', date: new Date('2026-09-01T07:00:00Z'), status: 'approved', total: 38, items: [{ name: 'Latte', quantity: 1 }] });
    await age(holding.body.uploadId, 8 * DAY, { status: 'failed' });
    await cleanupAbandonedPendingUploads();
    expect((await Upload.findById(recent.body.uploadId).lean()).status).toBe('failed');
    expect((await Upload.findById(holding.body.uploadId).lean()).status).toBe('failed');
  });

  // Review of BE-03-T12: storage that cannot delete must not cost a failed upload its reason or its place in the queue.
  it('puts a failed upload whose file cannot be deleted back exactly as it was, with or without a reason', async () => {
    const { token } = await createTestUser();
    const withReason = await stage(token, csv('F4,2026-09-01,09:00,1 x Latte,38.00'));
    const withoutReason = await stage(token, csv('F5,2026-09-01,09:00,1 x Latte,38.00'));
    await age(withReason.body.uploadId, 8 * DAY, { status: 'failed', errorMessage: 'No valid transaction rows could be imported with this mapping' });
    await age(withoutReason.body.uploadId, 8 * DAY, { status: 'failed' });
    await Upload.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(withoutReason.body.uploadId)) }, { $unset: { errorMessage: '' } });
    const before = await Upload.find({}).select('status errorMessage updatedAt').sort({ _id: 1 }).lean();
    jest.spyOn(r2, 'deleteFile').mockRejectedValue(new Error('storage unavailable'));

    const summary = await cleanupAbandonedPendingUploads();

    expect(summary.failed).toBe(2);
    expect(await Upload.find({}).select('status errorMessage updatedAt').sort({ _id: 1 }).lean()).toEqual(before);
  });
});

describe('error codes and request shapes', () => {
  it('sends SEVERE_PARTIAL_IMPORT with the 422', async () => {
    const { token } = await createTestUser();
    const bad = Array.from({ length: 12 }, (_, i) => `B${i},not-a-date,09:00,1 x Latte,38.00`);
    const good = Array.from({ length: 8 }, (_, i) => `G${i},2026-09-01,09:00,1 x Latte,38.00`);
    const staged = await stage(token, csv(...bad, ...good));
    const res = await confirm(token, staged.body.uploadId);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'SEVERE_PARTIAL_IMPORT', details: { errors: 12, totalRows: 20 } });
  });

  it('answers 400, not 500, to a confirm or a menu action with no JSON body', async () => {
    const { token } = await createTestUser();
    const staged = await stage(token, csv('E1,2026-09-01,09:00,1 x Latte,38.00'));
    const noBody = await auth(request.post(`/api/uploads/${staged.body.uploadId}/confirm`), token).set('Content-Type', 'text/plain').send('columnMapping');
    expect(noBody.status).toBe(400);
    const created = await auth(request.post('/api/items'), token).set('Content-Type', 'text/plain').send('x');
    expect(created.status).toBe(400);
    const broken = await auth(request.post(`/api/uploads/${staged.body.uploadId}/confirm`), token).set('Content-Type', 'application/json').send('{"columnMapping":');
    expect(broken.status).toBe(400);
  });

  it('answers 400 CAFE_REQUIRED, not 500, when the token carries no cafe', async () => {
    const { token, user } = await createTestUser();
    // BE-02-T05: authMiddleware answers 401 to a cafe-less token while the user still has cafes, so take the user's cafes away first
    // (as BE-02-T05's own CAFE_REQUIRED test does); then the real claims with the cafe removed pass authMiddleware.
    await require('../../src/models/User.model').updateOne({ _id: user.id }, { $set: { cafeIds: [], activeCafeId: null } });
    const { iat, exp, ...claims } = jwt.decode(token);
    const noCafe = jwt.sign({ ...claims, cafeId: null }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const res = await auth(request.get('/api/items'), noCafe);
    expect(res.status).toBe(400); // BE-02-T05's requireActiveCafe; the fallback guard below answers 409 NO_ACTIVE_CAFE instead
    expect(res.body.code).toBe('CAFE_REQUIRED');
  });

  it('gives a legacy .xls the Save-As-CSV advice with its code', async () => {
    const { token } = await createTestUser();
    const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
    const res = await stage(token, ole2, 'Melkies Sale DEC 25.xls');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'LEGACY_XLS', message: expect.stringMatching(/CSV UTF-8/) });
  });

  it('stores the file under the type its bytes prove, not the one the browser claimed', async () => {
    const { token } = await createTestUser();
    const res = await auth(request.post('/api/transactions/upload'), token)
      .attach('file', csv('H1,2026-09-01,09:00,1 x Latte,38.00'), { filename: 'sales.csv', contentType: 'text/html' });
    expect(res.status).toBe(200);
    const { r2Key } = await Upload.findById(res.body.uploadId).lean();
    expect(mockR2ContentTypes.get(r2Key)).toBe('text/csv; charset=utf-8');
  });
});
