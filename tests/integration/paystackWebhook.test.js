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

describe('Paystack webhook signature', () => {
  it('refuses a webhook with no signature', async () => {
    const owner = await createTestUser();
    await credits(owner, 'sig-none');
    const lookup = jest.spyOn(axios, 'get');

    const res = await post(JSON.stringify(webhookEvent('charge.success', { reference: 'sig-none', amountRand: 99 })));

    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a webhook signed with another key', async () => {
    const raw = JSON.stringify(webhookEvent('charge.success', { reference: 'sig-wrong', amountRand: 99 }));
    expect((await post(raw, hmac(raw, 'sk_test_someone_else'))).status).toBe(401);
  });

  it('refuses a valid signature over a different body', async () => {
    const signedRaw = JSON.stringify(webhookEvent('charge.success', { reference: 'sig-tamper', amountRand: 99 }));
    const tampered = JSON.stringify(webhookEvent('charge.success', { reference: 'sig-tamper', amountRand: 1 }));
    expect((await post(tampered, hmac(signedRaw, process.env.PAYSTACK_SECRET_KEY))).status).toBe(401);
  });

  it('refuses every webhook when no Paystack key is configured', async () => {
    const raw = JSON.stringify(webhookEvent('charge.success', { reference: 'sig-nokey', amountRand: 99 }));
    const signature = hmac(raw, process.env.PAYSTACK_SECRET_KEY);
    delete process.env.PAYSTACK_SECRET_KEY;
    expect((await post(raw, signature)).status).toBe(401);
  });
});

describe('Paystack webhook settlement', () => {
  it('settles a pending plan payment from a signed charge.success by re-verifying with Paystack', async () => {
    const owner = await createTestUser();
    await session(owner, 'hook-plan', { kind: 'plan', amount: 899, plan: 'growth', billingCycle: 'monthly' });
    const lookup = verifyAlways('success', 899, 6100001);

    const res = await postSigned(webhookEvent('charge.success', { reference: 'hook-plan', amountRand: 899 }));

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(res.status).toBe(200);
    expect((await PaymentSession.findOne({ reference: 'hook-plan' }).lean()).status).toBe('paid');
    expect(org.plan).toBe('growth');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toMatch(/\/transaction\/verify\/hook-plan$/);
  });

  it('grants a replayed webhook once', async () => {
    const owner = await createTestUser();
    await credits(owner, 'hook-replay');
    const lookup = verifyAlways('success', 99, 6100002);
    const body = webhookEvent('charge.success', { reference: 'hook-replay', amountRand: 99 });

    const first = await postSigned(body);
    const second = await postSigned(body);

    const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(org.aiCredits.bonus).toBe(500);
    expect(org.fulfilledPaymentReferences.filter((ref) => ref === 'hook-replay')).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('grants concurrent duplicate webhooks once', async () => {
    const owner = await createTestUser();
    await credits(owner, 'hook-concurrent');
    verifyAlways('success', 99, 6100003);
    const body = webhookEvent('charge.success', { reference: 'hook-concurrent', amountRand: 99 });

    const responses = await Promise.all([postSigned(body), postSigned(body), postSigned(body)]);

    expect(responses.every((res) => [200, 500].includes(res.status))).toBe(true);
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
    expect((await PaymentSession.findOne({ reference: 'hook-concurrent' }).lean()).status).toBe('paid');
  });

  it('acknowledges an unknown reference without creating anything', async () => {
    const lookup = jest.spyOn(axios, 'get');
    const res = await postSigned(webhookEvent('charge.success', { reference: 'nobody-has-this', amountRand: 99 }));

    expect(res.status).toBe(200);
    expect(await PaymentSession.countDocuments({})).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('holds an amount mismatch for a person instead of granting or expiring it', async () => {
    const owner = await createTestUser();
    await credits(owner, 'hook-mismatch');
    verifyAlways('success', 120, 6100004);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await postSigned(webhookEvent('charge.success', { reference: 'hook-mismatch', amountRand: 120 }));

    expect(res.status).toBe(200);
    expect((await PaymentSession.findOne({ reference: 'hook-mismatch' }).lean()).status).toBe('needs_attention');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);
  });

  it('records a refund against the payment it refunds', async () => {
    const owner = await createTestUser();
    await credits(owner, 'hook-refund');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: verifyResponse('success', { reference: 'hook-refund', amountRand: 99, id: 6100005 }) })
      .mockResolvedValueOnce({ data: verifyResponse('reversed', { reference: 'hook-refund', amountRand: 99, id: 6100005 }) });
    await postSigned(webhookEvent('charge.success', { reference: 'hook-refund', amountRand: 99 }));

    const res = await postSigned(webhookEvent('refund.processed', { reference: 'hook-refund', amountRand: 99 }));

    expect(res.status).toBe(200);
    expect((await PaymentSession.findOne({ reference: 'hook-refund' }).lean()).status).toBe('reversed');
  });

  it('changes nothing when a dispute is opened on a paid session that Paystack still reports paid', async () => {
    const owner = await createTestUser();
    await credits(owner, 'hook-dispute');
    verifyAlways('success', 99, 6100006);
    await postSigned(webhookEvent('charge.success', { reference: 'hook-dispute', amountRand: 99 }));

    const res = await postSigned(webhookEvent('charge.dispute.create', { reference: 'hook-dispute', amountRand: 99 }));

    expect(res.status).toBe(200);
    expect((await PaymentSession.findOne({ reference: 'hook-dispute' }).lean()).status).toBe('paid');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
  });
});
