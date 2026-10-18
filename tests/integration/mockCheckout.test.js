const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const { addBillingCycle } = require('../../src/services/billingPlans.service');

const request = supertest(app);
const DAY = 24 * 60 * 60 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  process.env.BILLING_MOCK_ENABLED = 'true';
  await clearDB();
});

const buyPlan = (token, body, key) => {
  const req = request.post('/api/account/checkout').set('Authorization', `Bearer ${token}`);
  return (key ? req.set('Idempotency-Key', key) : req).send(body);
};
const buyCredits = (token, credits, key) => request
  .post('/api/account/ai-credits')
  .set('Authorization', `Bearer ${token}`)
  .set('Idempotency-Key', key)
  .send({ credits });
const conflictCode = (res) => res.body.code ?? res.body.details?.code;

describe('mock checkout shares real fulfilment (billing-12)', () => {
  it('does not replay a mock receipt after mock billing is disabled', async () => {
    const owner = await createTestUser();
    const body = { plan: 'growth', billingCycle: 'monthly' };
    const first = await buyPlan(owner.token, body, 'mock-disabled-replay');
    expect(first.status).toBe(200);
    expect(first.body.checkout.provider).toBe('mock');
    const before = await Organization.findById(owner.user.orgId).lean();
    process.env.BILLING_MOCK_ENABLED = 'false';
    const replay = await buyPlan(owner.token, body, 'mock-disabled-replay');
    expect(replay.status).toBe(503);
    expect(replay.body.checkout?.provider).not.toBe('mock');
    expect(await PaymentSession.countDocuments({ orgId: owner.user.orgId })).toBe(1);
    expect((await Organization.findById(owner.user.orgId).lean()).currentPeriodEnd).toEqual(before.currentPeriodEnd);
  });

  it('replays a paid scheduled downgrade without scheduling or charging again', async () => {
    const owner = await createTestUser();
    await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'setup-paid-growth');
    const first = await buyPlan(owner.token, { plan: 'starter', billingCycle: 'monthly' }, 'scheduled-replay');
    const before = await Organization.findById(owner.user.orgId).lean();
    const second = await buyPlan(owner.token, { plan: 'starter', billingCycle: 'monthly' }, 'scheduled-replay');
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.checkout.reference).toBe(first.body.checkout.reference);
    const after = await Organization.findById(owner.user.orgId).lean();
    expect(after.pendingPlanChange).toEqual(before.pendingPlanChange);
    expect(after.currentPeriodEnd).toEqual(before.currentPeriodEnd);
    expect(await PaymentSession.countDocuments({ orgId: owner.user.orgId, idempotencyKey: 'scheduled-replay' })).toBe(1);
    const blocked = await buyPlan(owner.token, { plan: 'pro', billingCycle: 'monthly' }, 'new-plan-during-pending');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PLAN_CHANGE_ALREADY_SCHEDULED');
  });

  it('concurrent mock plan checkouts with one key create one session and one term', async () => {
    const owner = await createTestUser();
    const responses = await Promise.all([0, 1].map(() =>
      buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'mock-concurrent')));
    expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    const sessions = await PaymentSession.find({ orgId: org._id, kind: 'plan' }).lean();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('paid');
    expect(org.fulfilledPaymentReferences).toEqual([sessions[0].reference]);
    expect(org.currentPeriodEnd).toEqual(addBillingCycle(org.currentPeriodStart, 'monthly'));
    for (const response of responses.filter((entry) => entry.status === 200)) {
      expect(response.body.checkout.reference).toBe(sessions[0].reference);
    }
  });

  it('one key can name a plan and a credit session without replaying either grant', async () => {
    const owner = await createTestUser();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'cross-kind')).status).toBe(200);
      expect((await buyCredits(owner.token, 500, 'cross-kind')).status).toBe(200);
    }
    const sessions = await PaymentSession.find({ orgId: owner.user.orgId, idempotencyKey: 'cross-kind' }).lean();
    expect(sessions.map((session) => session.kind).sort()).toEqual(['credits', 'plan']);
    const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    expect(org.fulfilledPaymentReferences).toHaveLength(2);
    expect(org.aiCredits.bonus).toBe(500);
  });

  it.each([
    { brand: 'x'.repeat(10000), last4: '12345' },
    { brand: { nested: 'visa' }, last4: { nested: '4242' } },
  ])('bounds mock card input instead of saving arbitrary metadata %#', async (paymentMethod) => {
    const owner = await createTestUser();
    const response = await buyPlan(owner.token,
      { plan: 'growth', billingCycle: 'monthly', paymentMethod }, 'hostile-card');
    expect(response.status).toBe(200);
    const session = await PaymentSession.findOne({ reference: response.body.checkout.reference }).lean();
    expect(session.card).toEqual({ brand: 'visa', last4: '4242' });
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.paymentMethod).toMatchObject({ brand: 'visa', last4: '4242', provider: 'mock' });
  });

  it('applies a replayed mock plan checkout once', async () => {
    const owner = await createTestUser();

    const first = await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'mock-plan-replay');
    const afterFirst = await Organization.findById(owner.user.orgId).lean();
    const second = await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'mock-plan-replay');

    const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    const sessions = await PaymentSession.find({ orgId: owner.user.orgId, kind: 'plan' }).lean();
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.checkout.reference).toBe(first.body.checkout.reference);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({ provider: 'mock', status: 'paid', plan: 'growth' }));
    expect(org.currentPeriodEnd).toEqual(afterFirst.currentPeriodEnd);
    expect(org.fulfilledPaymentReferences).toHaveLength(1);
  });

  it('refuses a reused key for a different plan instead of applying it', async () => {
    const owner = await createTestUser();
    await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'mock-plan-conflict');

    const res = await buyPlan(owner.token, { plan: 'pro', billingCycle: 'monthly' }, 'mock-plan-conflict');

    expect(res.status).toBe(409);
    expect(conflictCode(res)).toBe('PAYMENT_IDEMPOTENCY_CONFLICT');
    expect((await Organization.findById(owner.user.orgId).lean()).plan).toBe('growth');
  });

  it('refuses a reused key for a different credit pack instead of reporting it bought', async () => {
    const owner = await createTestUser();
    await buyCredits(owner.token, 500, 'mock-pack-conflict');

    const res = await buyCredits(owner.token, 1500, 'mock-pack-conflict');

    expect(res.status).toBe(409);
    expect(conflictCode(res)).toBe('PAYMENT_IDEMPOTENCY_CONFLICT');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
  });

  it('keeps credits already used this period when a mock renewal lands early (regression guard)', async () => {
    const owner = await createTestUser();
    await Organization.updateOne({ _id: owner.user.orgId }, {
      $set: {
        plan: 'growth', billingCycle: 'monthly', billingStatus: 'active',
        currentPeriodStart: new Date(Date.now() - 10 * DAY), currentPeriodEnd: new Date(Date.now() + 20 * DAY),
        'aiCredits.used': 37, 'aiCredits.bonusUsed': 0, 'aiCredits.resetAt': new Date(Date.now() + 20 * DAY),
      },
    });

    await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' }, 'mock-early-renewal');

    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.used).toBe(37);
  });

  it('records the mock payment like a real one: session, transaction id and card', async () => {
    const owner = await createTestUser();

    const res = await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly', paymentMethod: { brand: 'mastercard', last4: '5100' } }, 'mock-card');

    const stored = await PaymentSession.findOne({ reference: res.body.checkout.reference }).lean();
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(stored.providerTransactionId).toBe(`mock-${stored.reference}`);
    expect(stored.card).toEqual({ brand: 'mastercard', last4: '5100' });
    expect(org.paymentMethod).toEqual(expect.objectContaining({ brand: 'mastercard', last4: '5100', provider: 'mock' }));
  });

  it('records a session even for a client that sends no idempotency key', async () => {
    const owner = await createTestUser();

    const res = await buyPlan(owner.token, { plan: 'growth', billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    expect(await PaymentSession.countDocuments({ orgId: owner.user.orgId, kind: 'plan', provider: 'mock' })).toBe(1);
  });
});
