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
const Upload = require('../../src/models/Upload.model');
const { measureBudget } = require('../helpers/budget');

const request = supertest(app);
const LF = String.fromCharCode(10);
const lineOf = (bytes) => Buffer.concat([Buffer.from(`Receipt,Items${LF}`), Buffer.alloc(bytes, ',')]);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

describe('upload refuses hostile CSV shapes cheaply', () => {
  let token;
  beforeEach(async () => { ({ token } = await createTestUser()); });

  const stage = (buffer, name) => request
    .post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, name);

  it('[budget] refuses a 1 MB single-line CSV with a 400', async () => {
    const outcome = await measureBudget(() => stage(lineOf(1024 * 1024), 'one-mb-line.csv'));
    expect(outcome.result.status).toBe(400);
    expect(outcome.result.body.message).toMatch(/longer than 128 KB/);
    expect(outcome.elapsedMs).toBeLessThan(1000);
  });

  it('[budget] refuses a 10 MB single-line CSV with a 400 in under 1 s and 50 MB of heap', async () => {
    const outcome = await measureBudget(() => stage(lineOf(10 * 1024 * 1024 - 64), 'dos-wide-row.csv'));
    console.log(`upload 10 MB line: ${outcome.elapsedMs.toFixed(0)} ms, heap ${outcome.heapGrowthMb.toFixed(1)} MB, loop ${outcome.maxLoopDelayMs.toFixed(0)} ms`);
    expect(outcome.result.status).toBe(400);
    expect(outcome.result.body.message).toMatch(/longer than 128 KB/);
    expect(outcome.elapsedMs).toBeLessThan(1000);
    expect(outcome.heapGrowthMb).toBeLessThan(50);
    expect(await Upload.countDocuments()).toBe(0);
  });

  it('[budget] refuses a first line of an email-shaped header two hundred thousand dots long', async () => {
    const header = Buffer.from(`a@${'.'.repeat(200_000)}@,b${LF}1,2${LF}`);
    const outcome = await measureBudget(() => stage(header, 'dos-email-header.csv'));
    expect(outcome.result.status).toBe(400);
    expect(outcome.elapsedMs).toBeLessThan(1000);
  });

  it('still stages an ordinary file', async () => {
    const csv = ['Receipt,Date,Time,Items,Total', 'R1,2026-04-01,09:30,1 x Flat White,38.00'].join(LF);
    const response = await stage(Buffer.from(csv), 'ordinary.csv');
    expect(response.status).toBe(200);
    expect(response.body.headers).toEqual(['Receipt', 'Date', 'Time', 'Items', 'Total']);
  });
});
