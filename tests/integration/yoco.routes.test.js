jest.mock('axios');

const crypto = require('crypto');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const { buildYocoApp } = require('../helpers/yocoApp');
const Cafe = require('../../src/models/Cafe.model');
const { createOAuthState } = require('../../src/services/yoco.service');

const request = supertest(app);
const yocoRequest = supertest(buildYocoApp());
const WEBHOOK_SECRET = `whsec_${Buffer.from('test-webhook-secret-key').toString('base64')}`;
const YOCO_ENV = {
  YOCO_API_URL: 'https://api.yoco.invalid',
  YOCO_IAM_URL: 'https://iam.yoco.invalid',
  YOCO_CLIENT_ID: 'yoco-id',
  YOCO_CLIENT_SECRET: 'yoco-secret',
  YOCO_REDIRECT_URI: 'http://localhost:5185/connect',
  YOCO_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let savedEnv;
let consoleSpies;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, YOCO_ENV);
  delete process.env.API_PUBLIC_URL;
  axios.get.mockReset();
  axios.post.mockReset();
  consoleSpies = ['warn', 'log', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(async () => {
  process.env = savedEnv;
  consoleSpies.forEach((spy) => spy.mockRestore());
  await clearDB();
});

const ownerWithCafe = async () => {
  const { token } = await createTestUser();
  const me = await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  return { token, cafeId: me.body.activeCafeId };
};

// An id_token whose payload carries the business id; the signature is not checked for a token received
// directly from Yoco's token endpoint over TLS (OIDC Core 3.1.3.7).
const idTokenWith = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

const tokenResponse = (extra = {}) => ({
  data: { access_token: 'y-access', refresh_token: 'y-refresh', expires_in: 3600, ...extra },
});

const signedWebhook = (body) => {
  const raw = JSON.stringify(body);
  const id = 'msg_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const signature = crypto.createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return yocoRequest.post('/api/yoco/webhook')
    .set('Content-Type', 'application/json')
    .set('webhook-id', id)
    .set('webhook-timestamp', timestamp)
    .set('webhook-signature', `v1,${signature}`)
    .send(raw);
};

describe('Yoco connect stores the business id webhooks route by', () => {
  it('persists the documented authorised business instead of the merchant default', async () => {
    const { token, cafeId } = await ownerWithCafe();
    axios.post.mockResolvedValue(tokenResponse({ id_token: idTokenWith({
      authorized_business_id: 'authorised-merchant', default_business_id: 'different-merchant',
    }) }));
    const res = await yocoRequest.post('/api/yoco/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-authorised', state: createOAuthState(cafeId) });
    expect(res.status).toBe(200);
    expect(res.body.webhookRouting).toBe('ready');
    expect((await Cafe.findById(cafeId).lean()).yocoBusinessId).toBe('authorised-merchant');
  });

  it('keeps the connection when public webhook registration fails and clears a stale subscription', async () => {
    process.env.API_PUBLIC_URL = 'https://api.yourguava.invalid';
    const { token, cafeId } = await ownerWithCafe();
    await Cafe.findByIdAndUpdate(cafeId, { $set: { yocoWebhookSubscriptionId: 'stale-subscription' } });
    axios.post.mockResolvedValueOnce(tokenResponse({ business_id: 'biz-registration-fails' }))
      .mockRejectedValueOnce({ response: { status: 503 }, config: { headers: { Authorization: 'private' } } });
    const res = await yocoRequest.post('/api/yoco/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-registration', state: createOAuthState(cafeId) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, webhookRouting: 'ready', webhook: 'failed' });
    const cafe = await Cafe.findById(cafeId).lean();
    expect(cafe.yocoConnected).toBe(true);
    expect(cafe.yocoWebhookSubscriptionId).toBeUndefined();
  });

  it('persists the business id from the id_token and reports routing ready', async () => {
    const { token, cafeId } = await ownerWithCafe();
    axios.post.mockResolvedValue(tokenResponse({ id_token: idTokenWith({ business_id: 'biz-9' }) }));

    const res = await yocoRequest.post('/api/yoco/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state: createOAuthState(cafeId) });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, webhookRouting: 'ready', webhook: 'skipped' });
    expect((await Cafe.findById(cafeId).lean()).yocoBusinessId).toBe('biz-9');
    const status = await yocoRequest.get('/api/yoco/status').set('Authorization', `Bearer ${token}`);
    expect(status.body.webhookRouting).toBe('ready');
  });

  it('accepts a business_id field on the token response too', async () => {
    const { token, cafeId } = await ownerWithCafe();
    axios.post.mockResolvedValue(tokenResponse({ business_id: 'biz-10' }));

    await yocoRequest.post('/api/yoco/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state: createOAuthState(cafeId) });

    expect((await Cafe.findById(cafeId).lean()).yocoBusinessId).toBe('biz-10');
  });

  it('connects without routing when Yoco names no business, and clears a stale id', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await Cafe.findByIdAndUpdate(cafeId, { $set: { yocoBusinessId: 'stale-biz' } });
    axios.post.mockResolvedValue(tokenResponse({ id_token: idTokenWith({ sub: 'user-1' }) }));

    const res = await yocoRequest.post('/api/yoco/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state: createOAuthState(cafeId) });

    expect(res.body.webhookRouting).toBe('unavailable');
    expect((await Cafe.findById(cafeId).lean()).yocoBusinessId).toBeUndefined();
  });

  it('registers the webhook subscription only for a public HTTPS API and stores its id', async () => {
    process.env.API_PUBLIC_URL = 'https://api.yourguava.invalid';
    const { token, cafeId } = await ownerWithCafe();
    axios.post
      .mockResolvedValueOnce(tokenResponse({ business_id: 'biz-11' }))
      .mockResolvedValueOnce({ data: { id: 'sub-1' } });

    const res = await yocoRequest.post('/api/yoco/callback').set('Authorization', `Bearer ${token}`)
      .send({ code: 'code-1', state: createOAuthState(cafeId) });

    expect(res.body.webhook).toBe('registered');
    expect(axios.post.mock.calls[1][0]).toBe('https://api.yoco.invalid/v1/webhooks/subscriptions/');
    expect(axios.post.mock.calls[1][1]).toMatchObject({ url: 'https://api.yourguava.invalid/api/yoco/webhook' });
    expect((await Cafe.findById(cafeId).lean()).yocoWebhookSubscriptionId).toBe('sub-1');
  });
});

describe('the webhook endpoint', () => {
  it('bounds the entire manual sync, rather than granting every page a new deadline', async () => {
    const { token, cafeId } = await ownerWithCafe();
    const { encryptSecret } = require('../../src/services/secrets.service');
    await Cafe.findByIdAndUpdate(cafeId, { $set: {
      yocoConnected: true,
      'yocoTokens.accessToken': encryptSecret('sync-access'),
      'yocoTokens.expiresAt': new Date(Date.now() + 3_600_000),
    } });
    process.env.OUTBOUND_YOCO_TIMEOUT_MS = '100';
    process.env.YOCO_SYNC_MAX_PAGES = '3';
    let page = 0;
    axios.get.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { data: { data: [], next_cursor: `page-${++page}` } };
    });
    const res = await yocoRequest.post('/api/yoco/sync').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(504);
    expect(res.body.code || res.body.details?.code).toBe('UPSTREAM_TIMEOUT');
    const countAtTimeout = axios.get.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(axios.get.mock.calls).toHaveLength(countAtTimeout);
    expect((await Cafe.findById(cafeId).lean()).lastSyncAt).toBeFalsy();
  });

  it('refuses a signed event without business_id with 400', async () => {
    const res = await signedWebhook({ event_type: 'payment.created', order_id: 'order-1' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ received: false, code: 'YOCO_WEBHOOK_BUSINESS_REQUIRED' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('forgets the business id and subscription on disconnect', async () => {
    const { token, cafeId } = await ownerWithCafe();
    await Cafe.findByIdAndUpdate(cafeId, { $set: {
      yocoConnected: true, yocoBusinessId: 'biz-12', yocoWebhookSubscriptionId: 'sub-12',
    } });

    const res = await yocoRequest.post('/api/yoco/disconnect').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const cafe = await Cafe.findById(cafeId).lean();
    expect(cafe.yocoBusinessId).toBeUndefined();
    expect(cafe.yocoWebhookSubscriptionId).toBeUndefined();
  });
});
