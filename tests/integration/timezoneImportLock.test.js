let mockDownloadGate = null;
let mockTimezoneReadFails = false;
const mockTimezoneReads = [];
jest.mock('../../src/utils/timezone', () => {
  const actual = jest.requireActual('../../src/utils/timezone');
  return {
    ...actual,
    getCafeTimezone: async (cafeId) => {
      const UploadModel = require('../../src/models/Upload.model');
      mockTimezoneReads.push(Boolean(await UploadModel.exists({ cafeId, status: 'parsing' })));
      if (mockTimezoneReadFails) throw new Error('Timezone read unavailable');
      return actual.getCafeTimezone(cafeId);
    },
  };
});
const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => { if (mockDownloadGate) await mockDownloadGate; return mockR2Files.get(key); },
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  invalidateInsights: async () => {},
  _resetMappingCache: () => {},
}));
const request = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Upload = require('../../src/models/Upload.model');
const Transaction = require('../../src/models/Transaction.model');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockDownloadGate = null;
  mockTimezoneReadFails = false;
  mockTimezoneReads.length = 0;
  mockR2Files.clear();
  await clearDB();
});

const ROWS = [
  'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount',
  '2026/02/000001,2026/02/10,09:30:00,Approved,Card,#0001,,1 x Flat White,,ZAR,0.0,0.0,0.0,40.0,0.0,40.0',
].join('\n');

it('locks timezone while the first import is downloading and keeps its original local times', async () => {
  const owner = await createTestUser();
  const auth = { Authorization: `Bearer ${owner.token}` };
  const stage = await request(app).post('/api/transactions/upload').set(auth).attach('file', Buffer.from(ROWS), 'one.csv');
  expect(stage.body.uploadId).toBeTruthy();
  mockTimezoneReads.length = 0;
  let releaseDownload;
  mockDownloadGate = new Promise((resolve) => { releaseDownload = resolve; });
  const confirmation = request(app).post(`/api/uploads/${stage.body.uploadId}/confirm`).set(auth)
    .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode }).then((res) => res);
  let parsing = false;
  for (let i = 0; i < 100; i += 1) {
    parsing = (await Upload.findById(stage.body.uploadId).lean()).status === 'parsing';
    if (parsing) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let change;
  let me;
  try {
    expect(parsing).toBe(true);
    me = await request(app).get('/api/cafe/me').set(auth);
    change = await request(app).put('/api/cafe/me').set(auth).send({ timezone: 'America/New_York' });
  } finally {
    releaseDownload();
  }
  const confirmed = await confirmation;
  expect(confirmed.status).toBe(200);
  expect(change.status).toBe(409);
  expect(change.body.code).toBe('TIMEZONE_LOCKED');
  expect(me.body.cafe.timezoneEditable).toBe(false);
  const tx = await Transaction.findOne({ cafeId: owner.user.activeCafeId }).lean();
  expect(tx.date.toISOString()).toBe('2026-02-10T07:30:00.000Z');
  expect(tx.hour).toBe(9);
  const after = await request(app).get('/api/cafe/me').set(auth);
  expect(after.body.cafe.timezone).toBe('Africa/Johannesburg');
  expect(mockTimezoneReads).toEqual([true]);
});

it('remapping reads the zone only after taking the parsing lease', async () => {
  const owner = await createTestUser();
  const auth = { Authorization: `Bearer ${owner.token}` };
  const stage = await request(app).post('/api/transactions/upload').set(auth).attach('file', Buffer.from(ROWS), 'one.csv');
  const body = { columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode };
  expect((await request(app).post(`/api/uploads/${stage.body.uploadId}/confirm`).set(auth).send(body)).status).toBe(200);
  mockTimezoneReads.length = 0;
  const remapped = await request(app).patch(`/api/uploads/${stage.body.uploadId}/mapping`).set(auth).send(body);
  expect(remapped.status).toBe(200);
  expect(mockTimezoneReads).toEqual([true]);
});

it('restores the parsing lease when reading the cafe timezone fails', async () => {
  const owner = await createTestUser();
  const auth = { Authorization: `Bearer ${owner.token}` };
  const stage = await request(app).post('/api/transactions/upload').set(auth).attach('file', Buffer.from(ROWS), 'one.csv');
  mockTimezoneReads.length = 0;
  mockTimezoneReadFails = true;
  const confirmed = await request(app).post(`/api/uploads/${stage.body.uploadId}/confirm`).set(auth)
    .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
  expect(confirmed.status).toBe(500);
  expect(mockTimezoneReads).toEqual([true]);
  expect((await Upload.findById(stage.body.uploadId).lean()).status).toBe('failed');
});
