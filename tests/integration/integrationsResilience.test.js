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
jest.mock('axios');

const mongoose = require('mongoose');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');
const xeroService = require('../../src/services/integrations/xero.service');
const { encryptSecret, decryptSecret } = require('../../src/services/secrets.service');
const { refreshIntegrationAccessToken } = require('../../src/services/integrations/tokens');
const { getValidToken } = require('../../src/services/yoco.service');
const { zonedDayStart, addZonedDays } = require('../../src/utils/timezone');

const request = supertest(app);
const XERO_ENV = {
  ACCOUNTING_INTEGRATIONS_ENABLED: 'true',
  XERO_CLIENT_ID: 'test-id',
  XERO_CLIENT_SECRET: 'test-secret',
  XERO_REDIRECT_URI: 'http://localhost:5185/integrations/xero/callback',
  YOCO_IAM_URL: 'https://iam.yoco.invalid',
  YOCO_CLIENT_ID: 'yoco-id',
  YOCO_CLIENT_SECRET: 'yoco-secret',
};

let savedEnv;
let consoleSpies;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, XERO_ENV);
  axios.get.mockReset();
  axios.post.mockReset();
  consoleSpies = ['warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(async () => {
  process.env = savedEnv;
  jest.restoreAllMocks();
  await clearDB();
});

const ownerWithCafe = async () => {
  const { token } = await createTestUser();
  const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, cafeId: me.body.activeCafeId };
};

const connectXero = (cafeId, overrides = {}) => Cafe.findByIdAndUpdate(cafeId, {
  $set: {
    'accountingIntegrations.xero.connected': true,
    'accountingIntegrations.xero.accessToken': encryptSecret('access-1'),
    'accountingIntegrations.xero.refreshToken': encryptSecret('refresh-1'),
    'accountingIntegrations.xero.expiresAt': new Date(Date.now() - 1000),
    'accountingIntegrations.xero.tenantId': 'tenant-1',
    ...overrides,
  },
});

const xeroSecrets = async (cafeId) => (await Cafe.findById(cafeId)
  .select('+accountingIntegrations.xero.accessToken +accountingIntegrations.xero.refreshToken')
  .lean()).accountingIntegrations.xero;

const providerFailure = (status, data) => Object.assign(
  new Error(`Request failed with status code ${status}`),
  { isAxiosError: true, response: { status, data } }
);

const authState = async (token) => {
  const res = await request.get('/api/integrations/xero/auth').set('Authorization', `Bearer ${token}`);
  return new URL(res.body.url).searchParams.get('state');
};

const XERO_TOKENS = { data: { access_token: 'x-access', refresh_token: 'x-refresh', expires_in: 1800 } };

describe('token refresh failures never reach the portal as a 401', () => {
  it('answers a revoked Xero grant with 502 INTEGRATION_REAUTH_REQUIRED and marks the connection disconnected', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    jest.spyOn(xeroService, 'refreshAccessToken')
      .mockRejectedValue(providerFailure(400, { error: 'invalid_grant' }));

    const res = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'INTEGRATION_REAUTH_REQUIRED' });
    expect(res.body.message).toMatch(/reconnect xero/i);
    expect(res.body.message).not.toMatch(/invalid_grant|status code/i);
    const xero = (await Cafe.findById(cafeId).lean()).accountingIntegrations.xero;
    expect(xero).toMatchObject({ connected: false, lastSyncStatus: 'failed' });
  });

  it('answers a provider 401 with 502 UPSTREAM_AUTH_FAILED and keeps the connection', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    jest.spyOn(xeroService, 'refreshAccessToken')
      .mockRejectedValue(providerFailure(401, { error: 'invalid_client', error_description: 'client secret wrong' }));

    const res = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('UPSTREAM_AUTH_FAILED');
    expect(res.body.message).not.toMatch(/client secret/i);
    expect((await Cafe.findById(cafeId).lean()).accountingIntegrations.xero.connected).toBe(true);
  });
});

describe('concurrent refreshes share one provider call', () => {
  it('lets concurrent refreshes of one connection share a single provider call', async () => {
    const { cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const stored = (await xeroSecrets(cafeId)).refreshToken;
    const service = {
      refreshAccessToken: jest.fn(() => new Promise((resolve) => setTimeout(() => resolve({
        accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 1800,
      }), 50))),
    };

    const results = await Promise.all([1, 2].map(() =>
      refreshIntegrationAccessToken({ cafeId, provider: 'xero', service, storedRefreshToken: stored })));

    expect(service.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['access-2', 'access-2']);
    expect(decryptSecret((await xeroSecrets(cafeId)).refreshToken)).toBe('refresh-2');
  });

  it('keeps the tokens another request saved first instead of overwriting them', async () => {
    const { cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const stored = (await xeroSecrets(cafeId)).refreshToken;
    await Cafe.findByIdAndUpdate(cafeId, { $set: {
      'accountingIntegrations.xero.accessToken': encryptSecret('access-other'),
      'accountingIntegrations.xero.refreshToken': encryptSecret('refresh-other'),
    } });
    const service = { refreshAccessToken: jest.fn(async () => ({
      accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 1800,
    })) };

    const result = await refreshIntegrationAccessToken({
      cafeId, provider: 'xero', service, storedRefreshToken: stored,
    });

    expect(result).toBe('access-other');
    expect(decryptSecret((await xeroSecrets(cafeId)).refreshToken)).toBe('refresh-other');
  });

  it('shares one Yoco token refresh between concurrent syncs', async () => {
    const cafe = await Cafe.create({
      name: 'Yoco Cafe',
      orgId: new mongoose.Types.ObjectId(),
      yocoConnected: true,
      yocoTokens: {
        accessToken: encryptSecret('y-access-1'),
        refreshToken: encryptSecret('y-refresh-1'),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const doc = await Cafe.findById(cafe._id).select('+yocoTokens.accessToken +yocoTokens.refreshToken');
    axios.post.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({
      data: { access_token: 'y-access-2', refresh_token: 'y-refresh-2', expires_in: 3600 },
    }), 50)));

    const tokens = await Promise.all([getValidToken(doc), getValidToken(doc)]);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(['y-access-2', 'y-access-2']);
  });
});

describe('the OAuth callback stores only a provider-verified account id', () => {
  it('refuses a tenantId that Xero did not authorise, and revokes the unused grant', async () => {
    const { token, cafeId } = await ownerWithCafe();
    const state = await authState(token);
    axios.post.mockResolvedValue(XERO_TOKENS);
    axios.get.mockResolvedValue({ data: [{ tenantId: 'tenant-1' }] });

    const res = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state, tenantId: 'tenant-2' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INTEGRATION_ACCOUNT_MISMATCH');
    expect(axios.post).toHaveBeenCalledWith(
      'https://identity.xero.com/connect/revocation',
      expect.stringContaining('token=x-refresh'),
      expect.anything()
    );
    expect((await Cafe.findById(cafeId).lean()).accountingIntegrations?.xero?.connected).not.toBe(true);
  });

  it('asks the owner to choose when Xero authorised several organisations', async () => {
    const { token } = await ownerWithCafe();
    const state = await authState(token);
    axios.post.mockResolvedValue(XERO_TOKENS);
    axios.get.mockResolvedValue({ data: [{ tenantId: 'tenant-1' }, { tenantId: 'tenant-2' }] });

    const res = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INTEGRATION_ACCOUNT_CHOICE_REQUIRED');
    expect(res.body.message).toMatch(/2 organisations/);
  });

  it('stores the one organisation Xero authorised', async () => {
    const { token, cafeId } = await ownerWithCafe();
    const state = await authState(token);
    axios.post.mockResolvedValue(XERO_TOKENS);
    axios.get.mockResolvedValue({ data: [{ tenantId: 'tenant-1' }] });

    const res = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state });

    expect(res.status).toBe(200);
    expect((await Cafe.findById(cafeId).lean()).accountingIntegrations.xero)
      .toMatchObject({ connected: true, tenantId: 'tenant-1' });
  });

  it('refuses a malformed tenantId before spending the one-time state', async () => {
    const { token } = await ownerWithCafe();
    const state = await authState(token);
    axios.post.mockResolvedValue(XERO_TOKENS);
    axios.get.mockResolvedValue({ data: [{ tenantId: 'tenant-1' }] });

    const bad = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state, tenantId: { $ne: null } });
    const good = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state, tenantId: 'tenant-1' });

    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_PROVIDER_ACCOUNT_ID');
    expect(good.status).toBe(200);
  });
});

describe('disconnect revokes the grant and forgets the account', () => {
  it('revokes the refresh token at Xero and clears the organisation and sync history', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId, {
      'accountingIntegrations.xero.lastSyncAt': new Date(),
      'accountingIntegrations.xero.lastSyncStatus': 'success',
      'accountingIntegrations.xero.lastSyncedThrough': new Date(),
    });
    const revoke = jest.spyOn(xeroService, 'revokeToken').mockResolvedValue();

    const res = await request.post('/api/integrations/xero/disconnect').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.revocation).toBe('revoked');
    expect(revoke).toHaveBeenCalledWith('refresh-1');
    const xero = (await Cafe.findById(cafeId).lean()).accountingIntegrations.xero;
    expect(xero.connected).toBe(false);
    expect(xero.tenantId).toBeUndefined();
    expect(xero.lastSyncAt).toBeUndefined();
    expect(xero.lastSyncedThrough).toBeUndefined();
  });

  it('still disconnects when the provider refuses the revocation', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    jest.spyOn(xeroService, 'revokeToken').mockRejectedValue(providerFailure(503, {}));

    const res = await request.post('/api/integrations/xero/disconnect').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.revocation).toBe('failed');
    expect((await xeroSecrets(cafeId)).refreshToken).toBeFalsy();
  });
});

describe('sync sends each closed cafe-local day once', () => {
  it('syncs only closed days and never sends the same day twice', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId, { 'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600 * 1000) });
    const tz = 'Africa/Johannesburg';
    const threeDaysAgo = new Date(addZonedDays(new Date(), -3, tz).getTime() + 10 * 3600 * 1000);
    await Transaction.create([
      { cafeId, date: threeDaysAgo, status: 'approved', total: 60, tip: 5,
        items: [{ name: 'Latte', quantity: 2, unitPrice: 30 }] },
      { cafeId, date: new Date(), status: 'approved', total: 40,
        items: [{ name: 'Scone', quantity: 1, unitPrice: 40 }] },
    ]);
    const push = jest.spyOn(xeroService, 'pushSalesSummary').mockResolvedValue({ ok: true, providerRef: 'xero-1' });

    const first = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);
    const second = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);

    const todayStart = zonedDayStart(new Date(), tz).getTime();
    expect(first.status).toBe(200);
    const [, summary] = push.mock.calls[0];
    expect(summary).toMatchObject({ transactionCount: 1, totalRevenue: 60, totalTip: 5, itemBreakdown: { Latte: 60 } });
    expect(new Date(summary.periodEnd).getTime()).toBe(todayStart);
    expect(second.status).toBe(200);
    expect(second.body.upToDate).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    const stored = (await Cafe.findById(cafeId).lean()).accountingIntegrations.xero.lastSyncedThrough;
    expect(new Date(stored).getTime()).toBe(todayStart);
  });

  it('never repeats a provider status for a failed push', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId, { 'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600 * 1000) });
    jest.spyOn(xeroService, 'pushSalesSummary').mockResolvedValue({ ok: false, statusCode: 401, error: 'Xero said no' });

    const res = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect((await Cafe.findById(cafeId).lean()).accountingIntegrations.xero.lastSyncedThrough).toBeUndefined();
  });
});

describe('refresh compare-and-set remains safe during disconnect and deploy overlap', () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };

  it('does not clear a newer accounting connection after an old invalid_grant', async () => {
    const { cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const stored = (await xeroSecrets(cafeId)).refreshToken;
    const response = deferred();
    const started = deferred();
    const service = { refreshAccessToken: jest.fn(() => { started.resolve(); return response.promise; }) };
    const pending = refreshIntegrationAccessToken({ cafeId, provider: 'xero', service, storedRefreshToken: stored });
    const outcome = pending.catch((error) => error);
    await started.promise;
    await Cafe.updateOne({ _id: cafeId }, { $set: {
      'accountingIntegrations.xero.accessToken': encryptSecret('winner-access'),
      'accountingIntegrations.xero.refreshToken': encryptSecret('winner-refresh'),
    } });
    response.reject(providerFailure(400, { error: 'invalid_grant' }));
    await outcome;
    const current = await xeroSecrets(cafeId);
    expect(current.connected).toBe(true);
    expect(decryptSecret(current.refreshToken)).toBe('winner-refresh');
    expect(decryptSecret(current.accessToken)).toBe('winner-access');
  });

  it('does not resurrect accounting tokens when disconnect wins during refresh', async () => {
    const { cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const stored = (await xeroSecrets(cafeId)).refreshToken;
    const response = deferred();
    const started = deferred();
    const service = { refreshAccessToken: jest.fn(() => { started.resolve(); return response.promise; }) };
    const pending = refreshIntegrationAccessToken({ cafeId, provider: 'xero', service, storedRefreshToken: stored });
    const outcome = pending.catch((error) => error);
    await started.promise;
    await Cafe.updateOne({ _id: cafeId }, { $set: {
      'accountingIntegrations.xero.connected': false,
      'accountingIntegrations.xero.accessToken': null,
      'accountingIntegrations.xero.refreshToken': null,
    } });
    response.resolve({ accessToken: 'late-access', refreshToken: 'late-refresh', expiresIn: 1800 });
    expect(await outcome).toMatchObject({ publicCode: 'INTEGRATION_DISCONNECTED', statusCode: 409 });
    const current = await xeroSecrets(cafeId);
    expect(current.connected).toBe(false);
    expect(current.refreshToken).toBeFalsy();
    expect(current.accessToken).toBeFalsy();
  });

  const expiredYoco = async () => {
    const cafe = await Cafe.create({
      name: 'Yoco race Cafe', orgId: new mongoose.Types.ObjectId(), yocoConnected: true,
      yocoTokens: {
        accessToken: encryptSecret('old-access'), refreshToken: encryptSecret('old-refresh'),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    return Cafe.findById(cafe._id).select('+yocoTokens.accessToken +yocoTokens.refreshToken');
  };

  it('does not disconnect a newer Yoco connection after an old invalid_grant', async () => {
    const cafe = await expiredYoco();
    const response = deferred();
    const started = deferred();
    axios.post.mockImplementation(() => { started.resolve(); return response.promise; });
    const outcome = getValidToken(cafe).catch((error) => error);
    await started.promise;
    await Cafe.updateOne({ _id: cafe._id }, { $set: {
      'yocoTokens.accessToken': encryptSecret('winner-access'),
      'yocoTokens.refreshToken': encryptSecret('winner-refresh'),
    } });
    response.reject(providerFailure(400, { error: 'invalid_grant' }));
    await outcome;
    const current = await Cafe.findById(cafe._id).select('+yocoTokens.refreshToken').lean();
    expect(current.yocoConnected).toBe(true);
    expect(decryptSecret(current.yocoTokens.refreshToken)).toBe('winner-refresh');
  });

  it('does not return an absent Yoco token after disconnect wins during refresh', async () => {
    const cafe = await expiredYoco();
    const response = deferred();
    const started = deferred();
    axios.post.mockImplementation(() => { started.resolve(); return response.promise; });
    const outcome = getValidToken(cafe).catch((error) => error);
    await started.promise;
    await Cafe.updateOne({ _id: cafe._id }, { $set: { yocoConnected: false }, $unset: { yocoTokens: 1 } });
    response.resolve({ data: { access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 1800 } });
    expect(await outcome).toMatchObject({ statusCode: 409, publicCode: 'INTEGRATION_DISCONNECTED' });
    const current = await Cafe.findById(cafe._id).select('+yocoTokens.refreshToken').lean();
    expect(current.yocoConnected).toBe(false);
    expect(current.yocoTokens?.refreshToken).toBeFalsy();
  });
});

describe('review regressions for connection ownership and lifecycle', () => {
  it.each(['SECRET_KEY_UNAVAILABLE', 'SECRET_MALFORMED'])(
    'reconnect succeeds and keeps the new grant when the replaced token has %s', async (code) => {
      const { token, cafeId } = await ownerWithCafe();
      const state = await authState(token);
      let unreadable = 'enc:v2:malformed';
      if (code === 'SECRET_KEY_UNAVAILABLE') {
        const key = process.env.TOKEN_ENCRYPTION_KEY;
        process.env.TOKEN_ENCRYPTION_KEY = '19'.repeat(32);
        unreadable = encryptSecret('old-refresh');
        process.env.TOKEN_ENCRYPTION_KEY = key;
      }
      expect(() => decryptSecret(unreadable)).toThrow(expect.objectContaining({ code }));
      await connectXero(cafeId, { 'accountingIntegrations.xero.refreshToken': unreadable });
      jest.spyOn(xeroService, 'exchangeCodeForTokens').mockResolvedValue({
        accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 1800, tenantId: 'tenant-2',
      });
      const revoke = jest.spyOn(xeroService, 'revokeToken').mockResolvedValue();
      const res = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
        .send({ code: 'new-grant', state });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const current = await xeroSecrets(cafeId);
      expect(current.connected).toBe(true);
      expect(current.tenantId).toBe('tenant-2');
      expect(decryptSecret(current.accessToken)).toBe('new-access');
      expect(decryptSecret(current.refreshToken)).toBe('new-refresh');
      expect(revoke).not.toHaveBeenCalled();
    }
  );

  it('reconnect with the same refresh token keeps the grant without revoking it', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const state = await authState(token);
    jest.spyOn(xeroService, 'exchangeCodeForTokens').mockResolvedValue({
      accessToken: 'new-access', refreshToken: 'refresh-1', expiresIn: 1800, tenantId: 'tenant-1',
    });
    const revoke = jest.spyOn(xeroService, 'revokeToken').mockResolvedValue();
    const res = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'same-grant', state });
    expect(res.status).toBe(200);
    expect(revoke).not.toHaveBeenCalled();
    const current = await xeroSecrets(cafeId);
    expect(current.connected).toBe(true);
    expect(decryptSecret(current.accessToken)).toBe('new-access');
    expect(decryptSecret(current.refreshToken)).toBe('refresh-1');
  });

  it('reconnect queues on the active refresh flight and revokes its rotated token', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const state = await authState(token);
    const stored = await xeroSecrets(cafeId);
    const started = deferred();
    const release = deferred();
    const service = { refreshAccessToken: jest.fn(() => { started.resolve(); return release.promise; }) };
    const refreshing = refreshIntegrationAccessToken({ cafeId, provider: 'xero', service, storedRefreshToken: stored.refreshToken });
    await started.promise;
    const exchanged = deferred();
    jest.spyOn(xeroService, 'exchangeCodeForTokens').mockImplementation(async () => {
      exchanged.resolve();
      return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 1800, tenantId: 'tenant-2' };
    });
    const findById = Cafe.findById;
    let callbackRead = false;
    jest.spyOn(Cafe, 'findById').mockImplementation(function (...args) {
      const query = findById.apply(this, args);
      const select = query.select;
      query.select = function (selection, ...rest) {
        if (selection === '+accountingIntegrations.xero.refreshToken') callbackRead = true;
        return select.call(this, selection, ...rest);
      };
      return query;
    });
    const revoke = jest.spyOn(xeroService, 'revokeToken').mockResolvedValue();
    const reconnecting = request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'racing-grant', state }).then((res) => res);
    await exchanged.promise;
    await new Promise(setImmediate);
    const readBeforeRelease = callbackRead;
    release.resolve({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 1800 });
    expect(await refreshing).toBe('rotated-access');
    expect((await reconnecting).status).toBe(200);
    expect(readBeforeRelease).toBe(false);
    expect(revoke.mock.calls).toEqual([['rotated-refresh']]);
    const current = await xeroSecrets(cafeId);
    expect(current.tenantId).toBe('tenant-2');
    expect(decryptSecret(current.refreshToken)).toBe('new-refresh');
  });

  const deferred = () => {
    let resolve;
    const promise = new Promise((yes) => { resolve = yes; });
    return { promise, resolve };
  };

  it('reconnect clears the previous account history atomically and then revokes its grant', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId, {
      'accountingIntegrations.xero.lastSyncedThrough': new Date(),
      'accountingIntegrations.xero.lastSyncAt': new Date(),
      'accountingIntegrations.xero.lastSyncStatus': 'failed',
      'accountingIntegrations.xero.lastSyncError': 'old account failure',
    });
    const state = await authState(token);
    jest.spyOn(xeroService, 'exchangeCodeForTokens').mockResolvedValue({
      accessToken: 'new-access', refreshToken: 'new-refresh', tenantId: 'tenant-2', expiresIn: 1800,
    });
    let atRevocation;
    const revoke = jest.spyOn(xeroService, 'revokeToken').mockImplementation(async () => {
      atRevocation = await xeroSecrets(cafeId);
    });
    const res = await request.post('/api/integrations/xero/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'new-grant', state });
    expect(res.status).toBe(200);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('refresh-1');
    expect(decryptSecret(atRevocation.refreshToken)).toBe('new-refresh');
    expect(atRevocation.tenantId).toBe('tenant-2');
    for (const field of ['lastSyncedThrough', 'lastSyncAt', 'lastSyncStatus', 'lastSyncError']) {
      expect(atRevocation[field]).toBeUndefined();
    }
    const current = await xeroSecrets(cafeId);
    expect(current.lastSyncedThrough).toBeUndefined();
    expect(current.lastSyncAt).toBeUndefined();
    expect(current.lastSyncStatus).toBeUndefined();
    expect(current.lastSyncError).toBeUndefined();
  });

  it('keeps concurrent expired Xero refreshes isolated between cafes', async () => {
    const owners = await Promise.all([0, 1].map(async (i) => ({ cafeId: (await Cafe.create({
      name: `Xero isolation ${i}`, orgId: new mongoose.Types.ObjectId(),
    }))._id })));
    await Promise.all(owners.map(({ cafeId }, i) => connectXero(cafeId, {
      'accountingIntegrations.xero.refreshToken': encryptSecret(`refresh-${i}`),
    })));
    const gate = deferred();
    const refresh = jest.spyOn(xeroService, 'refreshAccessToken').mockImplementation(async (token) => {
      await gate.promise;
      return { accessToken: `access-for-${token}`, refreshToken: `rotated-${token}`, expiresIn: 1800 };
    });
    const docs = await Promise.all(owners.map(({ cafeId }) => xeroSecrets(cafeId)));
    const pending = owners.map(({ cafeId }, i) => refreshIntegrationAccessToken({
      cafeId, provider: 'xero', service: xeroService, storedRefreshToken: docs[i].refreshToken,
    }));
    await new Promise(setImmediate);
    gate.resolve();
    expect(await Promise.all(pending)).toEqual(['access-for-refresh-0', 'access-for-refresh-1']);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const [i, { cafeId }] of owners.entries()) {
      const stored = await xeroSecrets(cafeId);
      expect(decryptSecret(stored.accessToken)).toBe(`access-for-refresh-${i}`);
      expect(decryptSecret(stored.refreshToken)).toBe(`rotated-refresh-${i}`);
    }
  });

  it('keeps concurrent expired Yoco refreshes isolated between cafes', async () => {
    const cafes = await Promise.all([0, 1].map((i) => Cafe.create({
      name: `Yoco isolation ${i}`, orgId: new mongoose.Types.ObjectId(), yocoConnected: true,
      yocoTokens: { accessToken: encryptSecret('expired'), refreshToken: encryptSecret(`y-refresh-${i}`),
        expiresAt: new Date(Date.now() - 1000) },
    })));
    const docs = await Promise.all(cafes.map((cafe) => Cafe.findById(cafe._id)
      .select('+yocoTokens.accessToken +yocoTokens.refreshToken')));
    const gate = deferred();
    axios.post.mockImplementation(async (_url, body) => {
      const refresh = new URLSearchParams(body).get('refresh_token');
      await gate.promise;
      return { data: { access_token: `access-for-${refresh}`, refresh_token: `rotated-${refresh}`, expires_in: 1800 } };
    });
    const pending = docs.map(getValidToken);
    await new Promise(setImmediate);
    gate.resolve();
    expect(await Promise.all(pending)).toEqual(['access-for-y-refresh-0', 'access-for-y-refresh-1']);
    expect(axios.post).toHaveBeenCalledTimes(2);
    for (const [i, cafe] of cafes.entries()) {
      const stored = await Cafe.findById(cafe._id).select('+yocoTokens.accessToken +yocoTokens.refreshToken').lean();
      expect(decryptSecret(stored.yocoTokens.accessToken)).toBe(`access-for-y-refresh-${i}`);
      expect(decryptSecret(stored.yocoTokens.refreshToken)).toBe(`rotated-y-refresh-${i}`);
    }
  });

  it('disconnect during a pending push leaves no watermark or sync history', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId, { 'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600000) });
    const started = deferred();
    const gate = deferred();
    jest.spyOn(xeroService, 'pushSalesSummary').mockImplementation(() => { started.resolve(); return gate.promise; });
    jest.spyOn(xeroService, 'revokeToken').mockResolvedValue();
    const pending = request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`).then((res) => res);
    await started.promise;
    const disconnected = await request.post('/api/integrations/xero/disconnect').set('Authorization', `Bearer ${token}`);
    gate.resolve({ ok: true });
    expect(disconnected.status).toBe(200);
    expect((await pending).status).toBe(200);
    const stored = await xeroSecrets(cafeId);
    for (const field of ['lastSyncedThrough', 'lastSyncAt', 'lastSyncStatus', 'lastSyncError']) {
      expect(stored[field]).toBeUndefined();
    }
  });

  it('disconnect waits for an active refresh and revokes the rotated grant before clearing', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId);
    const stored = await xeroSecrets(cafeId);
    const started = deferred();
    const gate = deferred();
    const service = { refreshAccessToken: jest.fn(() => { started.resolve(); return gate.promise; }) };
    const refresh = refreshIntegrationAccessToken({ cafeId, provider: 'xero', service, storedRefreshToken: stored.refreshToken });
    await started.promise;
    const revokeStarted = deferred();
    const revoke = jest.spyOn(xeroService, 'revokeToken').mockImplementation(async () => { revokeStarted.resolve(); });
    const pending = request.post('/api/integrations/xero/disconnect').set('Authorization', `Bearer ${token}`).then((res) => res);
    // Under the defect, disconnect reaches revocation before the refresh is released.
    await Promise.race([revokeStarted.promise, new Promise((resolve) => setTimeout(resolve, 150))]);
    gate.resolve({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 1800 });
    await refresh.catch(() => {});
    expect((await pending).status).toBe(200);
    expect(revoke.mock.calls).toEqual([['rotated-refresh']]);
    const current = await xeroSecrets(cafeId);
    expect(current.connected).toBe(false);
    expect(current.accessToken).toBeFalsy();
    expect(current.refreshToken).toBeFalsy();
  });
});

describe('concurrent syncs do not send the same closed days twice', () => {
  it('shares one push and advances the persisted watermark once', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await connectXero(cafeId, { 'accountingIntegrations.xero.expiresAt': new Date(Date.now() + 3600000) });
    const push = jest.spyOn(xeroService, 'pushSalesSummary').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true, providerRef: 'single-push' };
    });
    const responses = await Promise.all([1, 2].map(() => request.post('/api/integrations/xero/sync')
      .set('Authorization', `Bearer ${token}`)));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(push).toHaveBeenCalledTimes(1);
    const third = await request.post('/api/integrations/xero/sync').set('Authorization', `Bearer ${token}`);
    expect(third.body.upToDate).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
