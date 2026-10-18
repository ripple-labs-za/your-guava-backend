const fs = require('fs');
const path = require('path');

const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  getConfigurationStatus: () => ({ ok: true, configured: false, mode: 'local', missing: [] }),
  _resetClient: () => {},
}));

jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);
const genericPosFixture = path.join(__dirname, '..', 'fixtures', 'test-generic-pos.csv');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

describe('Launch smoke', () => {
  it('exercises signup, import, forecasting, account, and team basics', async () => {
    const health = await request
      .get('/api/health')
      .set('X-Request-Id', 'launch-smoke-health');

    expect(health.status).toBe(200);
    expect(health.headers['x-client-request-id']).toBe('launch-smoke-health');
    expect(health.body.requestId).toBe(health.headers['x-request-id']);

    const ready = await request.get('/api/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');

    const { token, user } = await createTestUser({
      email: 'launch-smoke@yourguava.com',
      cafeName: 'Launch Smoke Cafe',
      orgName: 'Launch Smoke Org',
    });

    expect(token).toBeTruthy();
    expect(user.activeCafeId).toBeTruthy();

    const cafe = await request
      .get('/api/cafe/me')
      .set('Authorization', `Bearer ${token}`);

    expect(cafe.status).toBe(200);
    expect(cafe.body.cafe.name).toBe('Launch Smoke Cafe');

    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', fs.readFileSync(genericPosFixture), 'generic-pos.csv');

    expect(stage.status).toBe(200);
    expect(stage.body.success).toBe(true);
    expect(stage.body.uploadId).toBeDefined();
    expect(stage.body.posType).toBe('wizard');
    expect(stage.body.needsConfirmation).toBe(true);

    const confirm = await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        columnMapping: {
          receiptId: 'Txn Number',
          date: 'Sale Date',
          time: 'Sale Time',
          items: 'Description',
          total: 'Amount',
        },
        itemsMode: 'packed',
      });

    expect(confirm.status).toBe(200);
    expect(confirm.body.success).toBe(true);
    expect(confirm.body.stats.imported).toBe(3);

    const stats = await request
      .get('/api/transactions/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(stats.status).toBe(200);
    expect(stats.body.stats.totalTransactions).toBe(3);
    expect(stats.body.stats.totalRevenue).toBeGreaterThan(0);

    const today = await request
      .get('/api/forecasts/today')
      .set('Authorization', `Bearer ${token}`);

    expect(today.status).toBe(200);
    expect(today.body.success).toBe(true);
    expect(today.body.forecast).toBeDefined();
    expect(today.body.forecast.signals).toBeDefined();

    const week = await request
      .get('/api/forecasts/week')
      .set('Authorization', `Bearer ${token}`);

    expect(week.status).toBe(200);
    expect(week.body.forecasts).toHaveLength(7);

    const account = await request
      .get('/api/account')
      .set('Authorization', `Bearer ${token}`);

    expect(account.status).toBe(200);
    expect(account.body.account.organization.name).toBe('Launch Smoke Org');

    const credits = await request
      .get('/api/account/credits')
      .set('Authorization', `Bearer ${token}`);

    expect(credits.status).toBe(200);
    expect(credits.body.credits).toBeDefined();

    const team = await request
      .get('/api/team')
      .set('Authorization', `Bearer ${token}`);

    expect(team.status).toBe(200);
    expect(team.body.members.length).toBeGreaterThanOrEqual(1);
  }, 60000);
});
