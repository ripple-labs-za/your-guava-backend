// BE-13-T02: the codes the portal tells apart reach the browser, on the wire, at the top level; every 429 says when to retry and a
// portal on another origin can read that.
const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  ...jest.requireActual('../../src/services/r2.service'),
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  maxObjectBytes: () => 2048, // read when transactions.routes loads: the multer limit in this file
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  ...jest.requireActual('../../src/services/anthropic.service'),
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const { meterGuavaCredits } = require('../../src/services/usage.service');
const UsageLedger = require('../../src/models/UsageLedger.model');
const Organization = require('../../src/models/Organization.model');
const { waitFor } = require('../helpers/waitFor');
const { xlsxWith } = require('../helpers/xlsx');

const request = supertest(app);
const CSV = 'Receipt,Date,Time,Items,Total\nR1,2026-04-01,08:30,1 x Flat White,35.00\nR2,2026-04-01,09:10,2 x Croissant,90.00\n';
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  delete process.env.AI_USER_CONCURRENCY_LIMIT;
  await clearDB();
});

const stageAndConfirm = async (token, body = CSV, key = 'be13-t02') => {
  const stage = await request.post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(body), 'sales.csv');
  const confirm = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', `${key}-${stage.body.uploadId}`)
    .send({ columnMapping: MAPPING, itemsMode: 'packed' });
  return { stage, confirm };
};

describe('API error contract (BE-13-T02)', () => {
  it('lets a portal on another origin read Retry-After and X-Request-Id', async () => {
    const res = await request.get('/api/health').set('Origin', process.env.CLIENT_URL);
    const exposed = String(res.headers['access-control-expose-headers'] || '');
    expect(exposed).toMatch(/Retry-After/);
    expect(exposed).toMatch(/X-Request-Id/);
  });

  it('answers an out-of-credits reservation with INSUFFICIENT_CREDITS, not a bare 402', async () => {
    const { user } = await createTestUser();
    const org = await Organization.findById(user.orgId).lean();
    const spent = (org.aiCredits?.included || 0) + (org.aiCredits?.bonus || 0);
    await Organization.updateOne({ _id: user.orgId }, { $set: { 'aiCredits.used': spent, 'aiCredits.bonusUsed': org.aiCredits?.bonus || 0 } });
    await expect(meterGuavaCredits({
      orgId: user.orgId, cafeId: user.activeCafeId, userId: user.id, featureKey: 'ask_guava_chat',
      idempotencyKey: 'be13-t02-no-credits', run: async () => ({ answer: 'never' }),
    })).rejects.toMatchObject({ statusCode: 402, code: 'INSUFFICIENT_CREDITS' });
  });

  it('tells a user with an AI request already running when to retry', async () => {
    process.env.AI_USER_CONCURRENCY_LIMIT = '1';
    const { user } = await createTestUser();
    let release;
    const first = meterGuavaCredits({
      orgId: user.orgId, cafeId: user.activeCafeId, userId: user.id, featureKey: 'ask_guava_chat',
      idempotencyKey: 'be13-t02-first', run: () => new Promise((resolve) => { release = resolve; }),
    });
    // The first request is reserved and inside its run (release is set there) before the second one asks.
    await waitFor(async () => release && UsageLedger.exists({ orgId: user.orgId, status: 'reserved' }), { message: 'the first AI request to be running' });
    await expect(meterGuavaCredits({
      orgId: user.orgId, cafeId: user.activeCafeId, userId: user.id, featureKey: 'ask_guava_chat',
      idempotencyKey: 'be13-t02-second', run: async () => ({ answer: 'second' }),
    })).rejects.toMatchObject({ statusCode: 429, code: 'AI_USER_CONCURRENCY_LIMIT', retryAfterSeconds: 5 });
    release({ answer: 'first' });
    await first;
  });

  it('names a re-upload of rows already on record UPLOAD_NO_NEW_ROWS', async () => {
    const { token } = await createTestUser();
    expect((await stageAndConfirm(token, CSV, 'first')).confirm.status).toBe(200);
    const second = await stageAndConfirm(token, CSV, 'second');
    expect(second.confirm.status).toBe(409);
    expect(second.confirm.body.code).toBe('UPLOAD_NO_NEW_ROWS');
  });

  it('refuses a file over the size limit with 413 UPLOAD_TOO_LARGE and the limit', async () => {
    const { token } = await createTestUser();
    const big = `${CSV}${'R9,2026-04-01,10:00,1 x Flat White,35.00\n'.repeat(80)}`;
    const res = await request.post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(big), 'big.csv');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('UPLOAD_TOO_LARGE');
    expect(res.body.details).toEqual({ maxBytes: 2048 });
  });

  it('names a legacy .xls file LEGACY_XLS, so the portal can give the Save-As-CSV advice', async () => {
    const { token } = await createTestUser();
    // The OLE2 compound-file signature that every .xls starts with.
    const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
    const res = await request.post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', xls, 'sales.xls');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LEGACY_XLS');
  });

  it('passes a parser code set only as err.code through to the portal (XLSX_UNREADABLE)', async () => {
    const { token } = await createTestUser();
    // A real workbook whose sheet XML breaks off mid-tag (deflated, to stay under this file's 2,048-byte upload limit).
    const broken = xlsxWith([['Receipt', 'Date', 'Items', 'Total']], { extraRowsXml: '<c <c <c ', deflate: true });
    const res = await request.post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', broken, 'sales.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('XLSX_UNREADABLE');
  });

  it('sends SEVERE_PARTIAL_IMPORT at the top level of the 422', async () => {
    const { token } = await createTestUser();
    const rows = Array.from({ length: 12 }, (_, i) => `B${i},not-a-date,08:30,1 x Flat White,abc`).join('\n');
    const { confirm } = await stageAndConfirm(token, `Receipt,Date,Time,Items,Total\n${rows}\nR99,2026-04-01,08:30,1 x Flat White,35.00\n`);
    expect(confirm.status).toBe(422);
    expect(confirm.body.code).toBe('SEVERE_PARTIAL_IMPORT');
  });
});
