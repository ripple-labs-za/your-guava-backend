jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async () => {}, downloadFile: async () => Buffer.from(''), getSignedDownloadUrl: async () => 'https://test.r2.local',
  deleteFile: async () => {}, _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app, assertPrototypesClean } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'];
const ROUTES = [
  ['get', (provider) => `/api/integrations/${provider}/auth`],
  ['post', (provider) => `/api/integrations/${provider}/callback`],
  ['post', (provider) => `/api/integrations/${provider}/sync`],
  ['post', (provider) => `/api/integrations/${provider}/disconnect`],
];

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  delete process.env.ACCOUNTING_INTEGRATIONS_ENABLED;
  await clearDB();
});

describe('accounting providers are checked against the real list', () => {
  let token;
  let cafeId;
  beforeEach(async () => {
    const owner = await createTestUser();
    token = owner.token;
    cafeId = owner.user.activeCafeId;
  });

  it.each(['true', 'false'])('refuses prototype keys as providers on every route (feature on: %s)', async (enabled) => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = enabled;
    for (const provider of PROTOTYPE_KEYS) {
      for (const [method, route] of ROUTES) {
        const response = await request[method](route(provider)).set('Authorization', `Bearer ${token}`).send({ code: 'x', state: 'y' });
        expect({ provider, route: route(provider), status: response.status, message: response.body.message })
          .toEqual({ provider, route: route(provider), status: 400, message: 'Unknown provider' });
      }
    }
    assertPrototypesClean();
  });

  it('sends a sales summary whose breakdown keeps items named like prototype keys', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    await Cafe.findByIdAndUpdate(cafeId, { $set: {
      'accountingIntegrations.xero.connected': true,
      'accountingIntegrations.xero.accessToken': 'plain-access-token',
      'accountingIntegrations.xero.refreshToken': 'plain-refresh-token',
      'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600 * 1000),
    } });
    await Transaction.create({
      // Accounting sends closed cafe-local days; keep this prototype-key fixture
      // inside that window instead of today's still-open day (BE-09-T02).
      cafeId, date: new Date(Date.now() - 2 * 86400000), dayOfWeek: 1, hour: 9, total: 40, status: 'approved',
      items: [{ name: '__proto__', quantity: 1, unitPrice: 10 }, { name: 'constructor', quantity: 3, unitPrice: 10 }],
    });

    const response = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);
    const breakdown = response.body.summary.itemBreakdown;
    expect(Object.prototype.hasOwnProperty.call(breakdown, '__proto__')).toBe(true);
    expect(breakdown.__proto__).toBe(10); // an own property after JSON.parse, not Object.prototype
    expect(breakdown.constructor).toBe(30);
    assertPrototypesClean();
  });
});
