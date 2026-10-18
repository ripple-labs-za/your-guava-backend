const crypto = require('crypto');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const { verifyResponse, webhookEvent } = require('../fixtures/paystack');

const request = supertest(app);
const ENV_KEYS = ['PAYMENT_PROVIDER', 'PAYSTACK_SECRET_KEY'];
let savedEnv;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.PAYMENT_PROVIDER = 'paystack';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only';
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] == null) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await clearDB();
});

const hmac = (raw, key) => crypto.createHmac('sha512', key).update(raw).digest('hex');
const post = (raw, signature) => {
  const req = request.post('/api/account/payments/paystack/webhook').set('Content-Type', 'application/json');
  return (signature ? req.set('x-paystack-signature', signature) : req).send(raw);
};
const postSigned = (body) => {
  const raw = JSON.stringify(body);
  return post(raw, hmac(raw, process.env.PAYSTACK_SECRET_KEY));
};
const session = (owner, reference, fields) => PaymentSession.create({
  orgId: owner.user.orgId, userId: owner.user.id, provider: 'paystack', reference, currency: 'ZAR', ...fields,
});
const credits = (owner, reference) => session(owner, reference, { kind: 'credits', amount: 99, credits: 500 });
const verifyAlways = (status, amountRand, id) => jest.spyOn(axios, 'get').mockImplementation(async (url) => ({
  data: verifyResponse(status, { reference: decodeURIComponent(String(url).split('/').pop()), amountRand, id }),
}));

const returnFor = (query) => request.get(`/api/account/payments/paystack/return?${query}`);
const outcome = (res) => new URL(res.headers.location).searchParams.get('payment');
const verifyOnce = (status, reference, amountRand, id) => jest.spyOn(axios, 'get')
  .mockResolvedValueOnce({ data: verifyResponse(status, { reference, amountRand, id }) });

describe('Paystack return', () => {
  it.each([
    ['success', 'paid', 'paid'],
    ['abandoned', 'pending', 'pending'],
    ['ongoing', 'pending', 'pending'],
    ['failed', 'failed', 'failed'],
    ['reversed', 'failed', 'failed'],
  ])('a %s verify redirects with payment=%s and leaves the session %s', async (status, redirected, stored) => {
    const owner = await createTestUser();
    await credits(owner, `ret-${status}`);
    verifyOnce(status, `ret-${status}`, 99, 6200001);

    const res = await returnFor(`reference=ret-${status}`);

    expect(res.status).toBe(302);
    expect(outcome(res)).toBe(redirected);
    expect(new URL(res.headers.location).searchParams.get('reference')).toBe(`ret-${status}`);
    expect((await PaymentSession.findOne({ reference: `ret-${status}` }).lean()).status).toBe(stored);
  });

  it('treats a reference Paystack does not know yet as pending', async () => {
    const owner = await createTestUser();
    await credits(owner, 'ret-404');
    jest.spyOn(axios, 'get').mockRejectedValueOnce({ response: { status: 404 } });

    const res = await returnFor('reference=ret-404');

    const stored = await PaymentSession.findOne({ reference: 'ret-404' }).lean();
    expect(outcome(res)).toBe('pending');
    expect(stored.status).toBe('pending');
    expect(stored.providerStatus).toBe('not_found');
  });

  it('ignores what the query string claims and believes only the verify call', async () => {
    const owner = await createTestUser();
    await credits(owner, 'ret-lie');
    verifyOnce('failed', 'ret-lie', 99, 6200002);

    const res = await returnFor('reference=ret-lie&trxref=ret-lie&status=success&payment=paid');

    expect(outcome(res)).toBe('failed');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);
  });

  it('redirects a reference that is not ours as pending without asking Paystack', async () => {
    const lookup = jest.spyOn(axios, 'get');
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await returnFor('reference=GGPNOTOURS');

    expect(outcome(res)).toBe('pending');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reports an amount mismatch as needing attention, never as paid', async () => {
    const owner = await createTestUser();
    await credits(owner, 'ret-mismatch');
    verifyOnce('success', 'ret-mismatch', 120, 6200003);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await returnFor('reference=ret-mismatch');

    expect(outcome(res)).toBe('needs_attention');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);
  });
});
