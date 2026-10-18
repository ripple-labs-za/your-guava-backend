const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const paystack = require('../../src/services/paystack.service');
const billing = require('../../src/services/billingPayments.service');
const paymentProvider = require('../../src/services/paymentProvider.service');

const request = supertest(app);
const ENV_KEYS = ['PAYMENT_PROVIDER', 'PAYSTACK_SECRET_KEY', 'BILLING_MOCK_ENABLED'];
let savedEnv;

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] == null) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await clearDB();
});

const usePaystack = () => {
  process.env.PAYMENT_PROVIDER = 'paystack';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only';
  return jest.spyOn(paystack, 'createPaymentKey').mockResolvedValue({
    key: 'access_fixture',
    url: 'https://checkout.paystack.com/access_fixture',
    origin: 'https://checkout.paystack.com',
  });
};
const checkout = (token, key) => request
  .post('/api/account/checkout')
  .set('Authorization', `Bearer ${token}`)
  .set('Idempotency-Key', key)
  .send({ plan: 'growth', billingCycle: 'monthly' });

describe('billing email (gap-9)', () => {
  it.each(['accounts@cafe', 'accounts cafe@x.co', 'a@b.co, other@victim.example'])('falls back from an invalid legacy billing address %s', async (billingEmail) => {
    const createPaymentKey = usePaystack();
    const owner = await createTestUser();
    const written = await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.user.orgId) }, { $set: { billingEmail } });
    expect(written.matchedCount).toBe(1);
    expect((await checkout(owner.token, 'invalid-legacy-email')).status).toBe(200);
    expect(createPaymentKey).toHaveBeenCalledWith(expect.objectContaining({ email: 'test@yourguava.com' }));
  });
  it('falls back to the login email for a whitespace-only legacy billing address', async () => {
    const createPaymentKey = usePaystack();
    const owner = await createTestUser();
    const written = await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.user.orgId) }, { $set: { billingEmail: '   ' } }
    );
    expect(written.matchedCount).toBe(1);
    const response = await checkout(owner.token, 'blank-legacy-billing-email');
    expect(response.status).toBe(200);
    expect(createPaymentKey).toHaveBeenCalledWith(expect.objectContaining({ email: 'test@yourguava.com' }));
  });

  it('normalizes legacy billing emails written before schema setters were applied', async () => {
    const createPaymentKey = usePaystack();
    const owner = await createTestUser();
    const written = await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.user.orgId) }, { $set: { billingEmail: '  Accounts@Cafe.Example  ' } }
    );
    expect(written.matchedCount).toBe(1);
    const response = await checkout(owner.token, 'legacy-billing-email');
    expect(response.status).toBe(200);
    expect(createPaymentKey).toHaveBeenCalledWith(expect.objectContaining({ email: 'accounts@cafe.example' }));
  });

  it('opens Paystack checkout, and so its receipts, with the billing email when one is set', async () => {
    const createPaymentKey = usePaystack();
    const owner = await createTestUser();
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { billingEmail: 'accounts@cafe.example' } });

    const res = await checkout(owner.token, 'billing-email-checkout');

    expect(res.status).toBe(200);
    expect(createPaymentKey).toHaveBeenCalledWith(expect.objectContaining({ email: 'accounts@cafe.example' }));
  });

  it('falls back to the owner login email when no billing email is set', async () => {
    const createPaymentKey = usePaystack();
    const owner = await createTestUser();
    await Organization.updateOne({ _id: owner.user.orgId }, { $unset: { billingEmail: 1 } });

    await checkout(owner.token, 'login-email-checkout');

    expect(createPaymentKey).toHaveBeenCalledWith(expect.objectContaining({ email: 'test@yourguava.com' }));
  });
});

describe('provider-neutral billing (billing-20, WS-05-T06)', () => {
  it('serializes two captured month-end renewals into two complete extra periods', async () => {
    const owner = await createTestUser();
    const year = new Date().getUTCFullYear() + 1;
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: {
      plan: 'growth', billingStatus: 'active', billingCycle: 'monthly',
      currentPeriodStart: new Date(Date.UTC(year - 1, 0, 31, 6)),
      currentPeriodEnd: new Date(Date.UTC(year, 2, 0, 6)),
    } });
    const payments = ['renewal-a', 'renewal-b'].map((reference) => ({
      reference, orgId: owner.user.orgId, plan: 'growth', billingCycle: 'monthly', provider: 'mock',
    }));
    const before = await Organization.findById(owner.user.orgId).lean();
    // Both captures read the same version before either can write. Without
    // the CAS retry, both would apply one renewal and lose the second month.
    const find = Organization.findById.bind(Organization);
    let releaseReads;
    const readsReady = new Promise((resolve) => { releaseReads = resolve; });
    let snapshots = 0;
    let completed = 0;
    jest.spyOn(Organization, 'findById').mockImplementation((...args) => {
      const query = find(...args);
      if (String(args[0]) !== String(owner.user.orgId) || snapshots >= 2) return query;
      snapshots += 1;
      const select = query.select.bind(query);
      query.select = (...fields) => Promise.resolve(select(...fields)).then(async (value) => {
        completed += 1;
        if (completed === 2) releaseReads();
        await readsReady;
        return value;
      });
      return query;
    });
    const results = await Promise.all(payments.map((payment) => billing.applyPlanPayment(payment, null)));
    jest.restoreAllMocks();
    expect(results.every((result) => result.applied)).toBe(true);
    const organization = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    expect(organization.currentPeriodEnd).toEqual(new Date(Date.UTC(year, 3, 30, 6)));
    expect(organization.__v).toBe(before.__v + 2);
    expect(organization.fulfilledPaymentReferences).toEqual(expect.arrayContaining(['renewal-a', 'renewal-b']));
  });

  it('labels an idempotent checkout replay with its saved session provider', async () => {
    usePaystack();
    const owner = await createTestUser();
    const first = await checkout(owner.token, 'provider-replay');
    expect(first.status).toBe(200);
    jest.spyOn(paymentProvider, 'providerName').mockReturnValue('onegate');
    const replay = await checkout(owner.token, 'provider-replay');
    expect(replay.status).toBe(200);
    expect(replay.body.checkout.reference).toBe(first.body.checkout.reference);
    expect(replay.body.checkout.provider).toBe('paystack');
  });

  it.each(['__proto__', 'constructor', 'toString', undefined, 'unknown'])('uses a neutral label for unknown provider %s', (provider) => {
    const { providerLabel } = require('../../src/services/billing/reconcile');
    expect(providerLabel(provider)).toBe('the payment provider');
  });

  it('names the session provider when a payment is not verified yet, never OneGate for Paystack', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture_only';
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId, userId: owner.user.id, provider: 'paystack', kind: 'credits',
      reference: 'not-verified-yet', amount: 99, currency: 'ZAR', credits: 500,
    });
    jest.spyOn(paystack, 'lookupGatewayTransaction').mockResolvedValue(null);

    const error = await billing.reconcilePayment(session.reference).catch((caught) => caught);

    expect(error.statusCode).toBe(202);
    expect(error.message).toMatch(/Paystack/);
    expect(error.message).not.toMatch(/OneGate/);
  });

  it('keeps the old reconciler names as aliases of the new ones', () => {
    expect(billing.reconcileOneGatePayment).toBe(billing.reconcilePayment);
    expect(billing.reconcilePendingOneGatePayments).toBe(billing.reconcilePendingPayments);
  });

  it('tells the portal which provider takes card payments', async () => {
    const owner = await createTestUser();
    const asMock = await request.get('/api/account').set('Authorization', `Bearer ${owner.token}`);
    usePaystack();
    const asPaystack = await request.get('/api/account').set('Authorization', `Bearer ${owner.token}`);
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.BILLING_MOCK_ENABLED;
    const unconfigured = await request.get('/api/account').set('Authorization', `Bearer ${owner.token}`);

    expect(asMock.body.account.billing).toEqual({ provider: 'mock' });
    expect(asPaystack.body.account.billing).toEqual({ provider: 'paystack' });
    expect(unconfigured.body.account.billing).toEqual({ provider: null });
  });

  it('reports the active billing provider to a manager without exposing the billing email', async () => {
    const owner = await createTestUser();
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { billingEmail: 'private@cafe.example' } });
    const response = await request.get('/api/account').set('Authorization', `Bearer ${manager.token}`);
    expect(response.status).toBe(200);
    expect(response.body.account.billing).toEqual({ provider: 'mock' });
    expect(response.body.account.organization.billingEmail).toBeUndefined();
  });

  it('labels a hosted checkout with the session provider', async () => {
    usePaystack();
    const owner = await createTestUser();

    const res = await checkout(owner.token, 'labelled-checkout');

    const session = await PaymentSession.findOne({ reference: res.body.checkout.reference }).lean();
    expect(res.body.checkout.provider).toBe(session.provider);
    expect(res.body.checkout.provider).toBe('paystack');
  });
});
