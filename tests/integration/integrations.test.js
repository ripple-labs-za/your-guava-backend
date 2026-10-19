jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async () => {},
  downloadFile: async () => Buffer.from(''),
  getSignedDownloadUrl: async () => 'https://test.r2.local',
  deleteFile: async () => {},
  _resetClient: () => {},
}));

jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  createTestManager,
  app,
} = require('../setup');
const {
  consumeIntegrationOAuthState,
} = require('../../src/services/integrationOAuthState.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Integrations API', () => {
  let token;
  let savedAccountingFlag;

  beforeEach(async () => {
    savedAccountingFlag = process.env.ACCOUNTING_INTEGRATIONS_ENABLED;
    delete process.env.ACCOUNTING_INTEGRATIONS_ENABLED;
    const u = await createTestUser();
    token = u.token;
  });

  afterEach(() => {
    if (savedAccountingFlag == null) delete process.env.ACCOUNTING_INTEGRATIONS_ENABLED;
    else process.env.ACCOUNTING_INTEGRATIONS_ENABLED = savedAccountingFlag;
  });

  it('GET /api/integrations returns initial disconnected state for all 3 providers', async () => {
    const res = await request
      .get('/api/integrations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.xero.connected).toBe(false);
    expect(res.body.data.quickbooks.connected).toBe(false);
    expect(res.body.data.sage.connected).toBe(false);
  });

  it('GET /api/integrations/:provider/auth returns 503 when accounting integrations are disabled', async () => {
    const res = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ACCOUNTING_INTEGRATIONS_NOT_AVAILABLE');
    expect(res.body.message).toMatch(/coming soon/i);
  });

  it('GET /api/integrations/:provider/auth returns 503 with clear error when env vars missing', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    // Ensure env vars are absent
    const savedId = process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_ID;

    const res = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('INTEGRATION_NOT_CONFIGURED');
    expect(res.body.message).toMatch(/XERO_CLIENT_ID/);

    if (savedId) process.env.XERO_CLIENT_ID = savedId;
  });

  it('GET /api/integrations/:provider/auth returns URL when env vars set', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    process.env.XERO_CLIENT_ID = 'test-id';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    process.env.XERO_REDIRECT_URI = 'http://localhost:5173/integrations/xero/callback';

    const res = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('login.xero.com');
    expect(res.body.url).toContain('client_id=test-id');

    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_REDIRECT_URI;
  });

  it('issues an opaque, cafe/user/provider-bound, single-use OAuth state', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    process.env.XERO_CLIENT_ID = 'test-id';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    process.env.XERO_REDIRECT_URI = 'http://localhost:5173/integrations/xero/callback';

    const authRes = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);
    const state = new URL(authRes.body.url).searchParams.get('state');
    const meRes = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(state).not.toContain(String(meRes.body.activeCafeId));

    const firstUse = await consumeIntegrationOAuthState({
      state,
      cafeId: meRes.body.activeCafeId,
      userId: meRes.body.id,
      provider: 'xero',
    });
    const replay = await consumeIntegrationOAuthState({
      state,
      cafeId: meRes.body.activeCafeId,
      userId: meRes.body.id,
      provider: 'xero',
    });

    expect(firstUse).toBe(true);
    expect(replay).toBe(false);

    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_REDIRECT_URI;
  });

  it('rejects a tampered OAuth state before contacting the provider', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    process.env.XERO_CLIENT_ID = 'test-id';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    process.env.XERO_REDIRECT_URI = 'http://localhost:5173/integrations/xero/callback';

    const authRes = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);
    const state = new URL(authRes.body.url).searchParams.get('state');

    const callbackRes = await request
      .post('/api/integrations/xero/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'test-code', state: `${state}tampered` });

    expect(callbackRes.status).toBe(400);
    expect(callbackRes.body.message).toMatch(/invalid or expired/i);

    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_REDIRECT_URI;
  });

  it('GET /api/integrations/unknown/auth returns 400', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    const res = await request
      .get('/api/integrations/unknown/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'treats a provider named %s as unknown, not as a built-in',
    async (provider) => {
      // The allow-list was a plain object, so services['constructor'] was
      // Object - truthy - and walked past the "Unknown provider" guard into a
      // 500. Only the three real providers are providers.
      process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
      const auth = await request
        .get(`/api/integrations/${provider}/auth`)
        .set('Authorization', `Bearer ${token}`);
      const sync = await request
        .post(`/api/integrations/${provider}/sync`)
        .set('Authorization', `Bearer ${token}`);

      expect(auth.status).toBe(400);
      expect(sync.status).toBe(400);
    }
  );

  it('GET /api/integrations requires auth', async () => {
    const res = await request.get('/api/integrations');
    expect(res.status).toBe(401);
  });

  it('allows managers to view status but reserves accounting mutations for owners', async () => {
    const meRes = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    const manager = await createTestManager(token, [meRes.body.activeCafeId]);

    const listRes = await request
      .get('/api/integrations')
      .set('Authorization', `Bearer ${manager.token}`);
    const authRes = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${manager.token}`);
    const disconnectRes = await request
      .post('/api/integrations/xero/disconnect')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(listRes.status).toBe(200);
    expect(authRes.status).toBe(403);
    expect(disconnectRes.status).toBe(403);
  });

  it('POST /api/integrations/:provider/disconnect clears tokens', async () => {
    const Cafe = require('../../src/models/Cafe.model');

    // Get the cafeId from the /auth/me response
    const meRes = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    // /auth/me returns activeCafeId at the top level; a missing one is a failure, not a skip.
    const cafeId = meRes.body.activeCafeId;
    expect(cafeId).toBeTruthy();

    // Simulate a connected Xero integration
    await Cafe.findByIdAndUpdate(cafeId, {
      $set: {
        'accountingIntegrations.xero.connected': true,
        'accountingIntegrations.xero.accessToken': 'fake-access-token',
        'accountingIntegrations.xero.refreshToken': 'fake-refresh-token',
      },
    });

    // Provider secrets stay excluded from ordinary cafe reads.
    const defaultView = await Cafe.findById(cafeId).lean();
    expect(defaultView.accountingIntegrations?.xero?.accessToken).toBeUndefined();
    expect(defaultView.accountingIntegrations?.xero?.refreshToken).toBeUndefined();

    // Secret-consuming paths must opt in explicitly.
    const before = await Cafe.findById(cafeId)
      .select('+accountingIntegrations.xero.accessToken +accountingIntegrations.xero.refreshToken')
      .lean();
    expect(before.accountingIntegrations?.xero?.connected).toBe(true);

    // Disconnect
    const res = await request
      .post('/api/integrations/xero/disconnect')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify tokens cleared
    const after = await Cafe.findById(cafeId)
      .select('+accountingIntegrations.xero.accessToken +accountingIntegrations.xero.refreshToken')
      .lean();
    expect(after.accountingIntegrations?.xero?.connected).toBe(false);
    expect(after.accountingIntegrations?.xero?.accessToken).toBeFalsy();
  });

  it('POST /api/integrations/:provider/sync returns 503 while accounting integrations are disabled', async () => {
    const res = await request
      .post('/api/integrations/xero/sync')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ACCOUNTING_INTEGRATIONS_NOT_AVAILABLE');
  });

  it('POST /api/integrations/:provider/sync returns 400 when not connected', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    const res = await request
      .post('/api/integrations/xero/sync')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Not connected');
  });

  it('POST /api/integrations/:provider/sync does not fake success before sales posting is implemented', async () => {
    process.env.ACCOUNTING_INTEGRATIONS_ENABLED = 'true';
    const Cafe = require('../../src/models/Cafe.model');

    const meRes = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    const cafeId =
      meRes.body.activeCafeId ||
      meRes.body.cafeId ||
      (meRes.body.cafeIds && meRes.body.cafeIds[0]);

    await Cafe.findByIdAndUpdate(cafeId, {
      $set: {
        'accountingIntegrations.xero.connected': true,
        'accountingIntegrations.xero.accessToken': 'plain-access-token',
        'accountingIntegrations.xero.refreshToken': 'plain-refresh-token',
        'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600 * 1000),
      },
    });

    const res = await request
      .post('/api/integrations/xero/sync')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(501);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not implemented/i);
  });

  it('POST /api/integrations/unknown/disconnect returns 400', async () => {
    const res = await request
      .post('/api/integrations/unknown/disconnect')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
