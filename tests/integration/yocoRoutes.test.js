jest.mock('axios');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser } = require('../setup');
const { buildYocoApp } = require('../helpers/yocoApp');
const { createOAuthState } = require('../../src/services/yoco.service');

// BE-12-T03 recipe f: the route-level refusals of the legacy Yoco router that yoco.routes.test.js
// (BE-09) does not reach. The connect flow itself is that file's.
const yoco = supertest(buildYocoApp());
const YOCO_ENV = {
  YOCO_CLIENT_ID: 'yoco-client-id',
  YOCO_CLIENT_SECRET: 'yoco-client-secret',
  YOCO_REDIRECT_URI: 'http://localhost:5185/connect',
  YOCO_API_URL: 'https://api.yoco.invalid',
  YOCO_IAM_URL: 'https://iam.yoco.invalid',
  YOCO_WEBHOOK_SECRET: `whsec_${Buffer.from('test-webhook-secret-key').toString('base64')}`,
};
let savedEnv;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedEnv = { ...process.env };
  Object.assign(process.env, YOCO_ENV);
});
afterEach(async () => {
  process.env = savedEnv;
  jest.resetAllMocks();
  await clearDB();
});

describe('legacy Yoco routes refuse before calling Yoco', () => {
  it('refuses a callback without a code, with a forged state, or with a state minted for another cafe', async () => {
    const owner = await createTestUser();
    const other = await createTestUser({ email: 'yoco-other@yourguava.com', cafeName: 'Other Cafe', orgName: 'Other Org' });
    const auth = { Authorization: `Bearer ${owner.token}` };

    const noCode = await yoco.post('/api/yoco/callback').set(auth).send({ state: 'x' });
    expect(noCode.status).toBe(400);
    expect(noCode.body.message).toBe('Authorization code required');

    const forged = await yoco.post('/api/yoco/callback').set(auth).send({ code: 'c', state: 'forged' });
    expect(forged.status).toBe(400);
    expect(forged.body.message).toBe('Invalid or expired OAuth state');

    const foreignState = createOAuthState(String(other.user.activeCafeId));
    const foreign = await yoco.post('/api/yoco/callback').set(auth).send({ code: 'c', state: foreignState });
    expect(foreign.status).toBe(400);

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('refuses a webhook with a bad signature and a sync for a cafe that is not connected', async () => {
    const owner = await createTestUser();
    const webhook = await yoco.post('/api/yoco/webhook')
      .set({ 'webhook-id': 'msg_1', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,bad' })
      .send({ type: 'payment.succeeded', payload: {} });
    expect(webhook.status).toBe(401);
    expect(webhook.body).toEqual(expect.objectContaining({ received: false }));

    const sync = await yoco.post('/api/yoco/sync').set('Authorization', `Bearer ${owner.token}`).send({});
    expect(sync.status).toBe(400);
    expect(sync.body.message).toBe('Yoco not connected');
    expect(axios.get).not.toHaveBeenCalled();
  });
});
