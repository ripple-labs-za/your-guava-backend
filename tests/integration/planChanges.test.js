const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const oneGate = require('../../src/services/onegate.service');
const { reconcileOneGatePayment } = require('../../src/services/billingPayments.service');
const { addBillingCycle } = require('../../src/services/billingPlans.service');

const request = supertest(app);
const DAY = 24 * 60 * 60 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  for (const key of ['PAYMENT_PROVIDER', 'ONEGATE_API_URL', 'ONEGATE_ORGANISATION_ID', 'ONEGATE_API_SALT', 'API_PUBLIC_URL']) {
    delete process.env[key];
  }
  process.env.BILLING_MOCK_ENABLED = 'true';
  await clearDB();
});

const paidTransaction = (reference, amount) => ({
  id: `provider-${reference}`,
  successful: 1,
  status: 'complete',
  amount: amount.toFixed(2),
  currency: 'ZAR',
  merchant_reference: reference,
});

const makeActive = (orgId, { plan, billingCycle, startDays, endDays, extra = {} }) => {
  const now = Date.now();
  return Organization.updateOne({ _id: orgId }, {
    $set: {
      plan,
      billingCycle,
      billingStatus: 'active',
      subscriptionStartedAt: new Date(now + startDays * DAY),
      currentPeriodStart: new Date(now + startDays * DAY),
      currentPeriodEnd: new Date(now + endDays * DAY),
      ...extra,
    },
  });
};

const payFor = async (owner, { plan, billingCycle, amount, reference }) => {
  const session = await PaymentSession.create({
    orgId: owner.user.orgId,
    userId: owner.user.id,
    provider: 'onegate',
    kind: 'plan',
    reference,
    amount,
    currency: 'ZAR',
    plan,
    billingCycle,
  });
  jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue(paidTransaction(reference, amount));
  return reconcileOneGatePayment(session.reference);
};

const scheduledStarter = (end) => ({
  plan: 'starter',
  billingCycle: 'monthly',
  effectiveAt: end,
  periodEnd: addBillingCycle(end, 'monthly'),
  reference: 'scheduled-starter',
});

describe('D-019 plan changes through fulfilment', () => {
  it('an upgrade starts now and credits the unused days of the current plan', async () => {
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'growth', billingCycle: 'monthly', startDays: -10, endDays: 20 });

    const paid = await payFor(owner, { plan: 'pro', billingCycle: 'monthly', amount: 1799, reference: 'upgrade-growth-pro' });

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(paid.status).toBe('paid');
    expect(org.plan).toBe('pro');
    expect(Math.abs(org.currentPeriodStart.getTime() - Date.now())).toBeLessThan(60_000);
    // 20 unused Growth days x R899/30 = R599.33, at R1,799/30 a day = 9.99, so 9 whole days.
    expect(org.currentPeriodEnd.getTime())
      .toBe(addBillingCycle(org.currentPeriodStart, 'monthly').getTime() + 9 * DAY);
    expect(org.aiCredits.included).toBe(6000);
    expect(org.pendingPlanChange).toBeUndefined();
  });

  it('a downgrade keeps the paid plan to the end of the period and schedules the new one', async () => {
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'pro', billingCycle: 'monthly', startDays: -10, endDays: 20 });
    const before = await Organization.findById(owner.user.orgId).lean();

    const paid = await payFor(owner, { plan: 'starter', billingCycle: 'monthly', amount: 399, reference: 'downgrade-pro-starter' });

    const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    expect(paid.status).toBe('paid');
    expect(org.plan).toBe('pro');
    expect(org.currentPeriodEnd).toEqual(before.currentPeriodEnd);
    expect(org.pendingPlanChange).toEqual(expect.objectContaining({
      plan: 'starter',
      billingCycle: 'monthly',
      reference: 'downgrade-pro-starter',
      effectiveAt: before.currentPeriodEnd,
      periodEnd: addBillingCycle(before.currentPeriodEnd, 'monthly'),
    }));
    expect(org.fulfilledPaymentReferences).toContain('downgrade-pro-starter');
  });

  it('an annual-to-monthly switch keeps the annual term and schedules monthly after it', async () => {
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'growth', billingCycle: 'annual', startDays: -60, endDays: 300 });
    const before = await Organization.findById(owner.user.orgId).lean();

    await payFor(owner, { plan: 'growth', billingCycle: 'monthly', amount: 899, reference: 'switch-annual-monthly' });

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.billingCycle).toBe('annual');
    expect(org.currentPeriodEnd).toEqual(before.currentPeriodEnd);
    expect(org.pendingPlanChange).toEqual(expect.objectContaining({
      plan: 'growth', billingCycle: 'monthly', effectiveAt: before.currentPeriodEnd,
    }));
  });

  it('a monthly-to-annual switch is scheduled for the end of the paid month', async () => {
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'growth', billingCycle: 'monthly', startDays: -10, endDays: 20 });
    const before = await Organization.findById(owner.user.orgId).lean();

    await payFor(owner, { plan: 'growth', billingCycle: 'annual', amount: 8990, reference: 'switch-monthly-annual' });

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.billingCycle).toBe('monthly');
    expect(org.pendingPlanChange).toEqual(expect.objectContaining({
      plan: 'growth',
      billingCycle: 'annual',
      effectiveAt: before.currentPeriodEnd,
      periodEnd: addBillingCycle(before.currentPeriodEnd, 'annual'),
    }));
  });

  it('a scheduled change takes effect on the first request after the period ends', async () => {
    const owner = await createTestUser();
    const end = new Date(Date.now() - 60_000);
    await makeActive(owner.user.orgId, {
      plan: 'pro', billingCycle: 'monthly', startDays: -31, endDays: 0,
      extra: { currentPeriodEnd: end, pendingPlanChange: scheduledStarter(end) },
    });

    const res = await request.get('/api/account').set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.account.organization).toEqual(expect.objectContaining({
      plan: 'starter',
      billingStatus: 'active',
      billingCycle: 'monthly',
      currentPeriodEnd: addBillingCycle(end, 'monthly').toISOString(),
      pendingPlanChange: null,
    }));
    expect(res.body.account.usage.guavaCredits.included).toBe(400);
  });

  it('concurrent requests apply a due change exactly once', async () => {
    const owner = await createTestUser();
    const end = new Date(Date.now() - 60_000);
    await makeActive(owner.user.orgId, {
      plan: 'pro', billingCycle: 'monthly', startDays: -31, endDays: 0,
      extra: { currentPeriodEnd: end, pendingPlanChange: scheduledStarter(end) },
    });
    const before = await Organization.findById(owner.user.orgId).lean();

    const responses = await Promise.all(Array.from({ length: 4 }, () =>
      request.get('/api/cafe/me').set('Authorization', `Bearer ${owner.token}`)));

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(org.__v).toBe((before.__v || 0) + 1);
    expect(org.currentPeriodEnd).toEqual(addBillingCycle(end, 'monthly'));
    expect(org.pendingPlanChange).toBeUndefined();
  });

  it('a due change preserves bonus usage reserved after the auth snapshot was read', async () => {
    const { applyDuePlanChange } = require('../../src/services/billingPayments.service');
    const { reserveCreditsAtomic } = require('../../src/services/usage/credits');
    const owner = await createTestUser();
    const end = new Date(Date.now() + 60_000);
    await makeActive(owner.user.orgId, {
      plan: 'pro', billingCycle: 'monthly', startDays: -31, endDays: 0,
      extra: {
        currentPeriodEnd: end, pendingPlanChange: scheduledStarter(end),
        'aiCredits.included': 6000, 'aiCredits.used': 6000,
        'aiCredits.bonus': 100, 'aiCredits.bonusUsed': 0,
      },
    });
    const snapshot = await Organization.findById(owner.user.orgId).lean();
    // An already authenticated request reserves purchased credits before the term ends.
    const reservation = await reserveCreditsAtomic(owner.user.orgId, 7, new Date());
    expect(reservation.allocation).toEqual({ included: 0, bonus: 7 });

    const applied = await applyDuePlanChange(snapshot, new Date(end.getTime() + 1));

    expect(applied.plan).toBe('starter');
    expect(applied.pendingPlanChange).toBeUndefined();
    expect(applied.aiCredits.bonusUsed).toBe(7);
    expect(applied.aiCredits.used).toBe(7);
    const persisted = await Organization.findById(owner.user.orgId).lean();
    expect(persisted.aiCredits.bonusUsed).toBe(7);
    expect(persisted.__v).toBe(snapshot.__v + 2);
  });

  it('checkout refuses another plan change while one is scheduled', async () => {
    const owner = await createTestUser();
    const end = new Date(Date.now() + 20 * DAY);
    await makeActive(owner.user.orgId, {
      plan: 'pro', billingCycle: 'monthly', startDays: -10, endDays: 20,
      extra: { currentPeriodEnd: end, pendingPlanChange: scheduledStarter(end) },
    });

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ plan: 'growth', billingCycle: 'monthly' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAN_CHANGE_ALREADY_SCHEDULED');
    expect(res.body.message).toMatch(/already paid for and starts on/i);
    expect(res.body.pendingPlanChange).toEqual(expect.objectContaining({ plan: 'starter', billingCycle: 'monthly' }));
    expect((await Organization.findById(owner.user.orgId).lean()).plan).toBe('pro');
  });

  it('holds a plan payment captured while another change is scheduled, never applying or discarding it', async () => {
    const owner = await createTestUser();
    const end = new Date(Date.now() + 20 * DAY);
    await makeActive(owner.user.orgId, {
      plan: 'pro', billingCycle: 'monthly', startDays: -10, endDays: 20,
      extra: { currentPeriodEnd: end, pendingPlanChange: scheduledStarter(end) },
    });
    const session = await PaymentSession.create({
      orgId: owner.user.orgId, userId: owner.user.id, provider: 'onegate', kind: 'plan',
      reference: 'second-plan-change', amount: 899, currency: 'ZAR', plan: 'growth', billingCycle: 'monthly',
    });
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue(paidTransaction(session.reference, 899));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await reconcileOneGatePayment(session.reference).catch(() => null);
    }

    const held = await PaymentSession.findById(session._id).lean();
    const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
    expect(held.status).toBe('needs_attention');
    expect(held.providerReason).toMatch(/already scheduled/i);
    expect(org.pendingPlanChange.reference).toBe('scheduled-starter');
    expect(org.fulfilledPaymentReferences).not.toContain('second-plan-change');
  });

  it('starts a scheduled change that fell due before judging a payment captured after it', async () => {
    const owner = await createTestUser();
    const end = new Date(Date.now() - 60_000);
    await makeActive(owner.user.orgId, {
      plan: 'pro', billingCycle: 'monthly', startDays: -31, endDays: 0,
      extra: { currentPeriodEnd: end, pendingPlanChange: scheduledStarter(end) },
    });

    // No request has reached the auth middleware since the Pro term ended; the renewal arrives by webhook.
    const paid = await payFor(owner, { plan: 'starter', billingCycle: 'monthly', amount: 399, reference: 'renew-after-due' });

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(paid.status).toBe('paid');
    expect(org.plan).toBe('starter');
    expect(org.pendingPlanChange).toBeUndefined();
    // The scheduled Starter month, then the renewal's month after it.
    expect(org.currentPeriodEnd.getTime())
      .toBeGreaterThanOrEqual(addBillingCycle(end, 'monthly').getTime() + 28 * DAY);
  });

  it('previews what every plan and cycle would do, for owners only', async () => {
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'growth', billingCycle: 'monthly', startDays: -10, endDays: 20 });

    const res = await request.get('/api/account').set('Authorization', `Bearer ${owner.token}`);

    const end = res.body.account.organization.currentPeriodEnd;
    const byKey = Object.fromEntries(res.body.account.planChanges.map((c) => [`${c.plan}/${c.billingCycle}`, c]));
    expect(res.body.account.planChanges).toHaveLength(6);
    expect(byKey['starter/monthly']).toEqual(expect.objectContaining({ type: 'downgrade', effectiveAt: end, blocked: null }));
    expect(byKey['growth/monthly'].type).toBe('renewal');
    expect(byKey['growth/annual']).toEqual(expect.objectContaining({ type: 'cycle_switch', effectiveAt: end }));
    expect(byKey['pro/monthly']).toEqual(expect.objectContaining({ type: 'upgrade', creditDays: 9 }));

    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
    const asManager = await request.get('/api/account').set('Authorization', `Bearer ${manager.token}`);
    expect(asManager.body.account.planChanges).toEqual([]);
  });

  it('mock checkout follows the same policy as a real payment', async () => {
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'growth', billingCycle: 'monthly', startDays: -10, endDays: 20 });

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ plan: 'starter', billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.checkout).toEqual(expect.objectContaining({ provider: 'mock', status: 'paid' }));
    expect(res.body.checkout.planChange).toEqual(expect.objectContaining({ type: 'downgrade', plan: 'starter' }));
    expect(res.body.account.organization.plan).toBe('growth');
    expect(res.body.account.organization.pendingPlanChange).toEqual(expect.objectContaining({ plan: 'starter' }));
  });

  it('a hosted checkout tells the portal what the payment will do before it is taken', async () => {
    process.env.PAYMENT_PROVIDER = 'onegate';
    process.env.ONEGATE_API_URL = 'https://payments.onegate.co.za';
    process.env.ONEGATE_ORGANISATION_ID = '21234';
    process.env.ONEGATE_API_SALT = 'test-salt';
    process.env.API_PUBLIC_URL = 'http://api.test';
    jest.spyOn(oneGate, 'createPaymentKey').mockResolvedValue({
      key: 'pay_key_plan_change',
      url: 'https://payments.onegate.co.za/pay/hosted?payment_key=pay_key_plan_change&payment_type=credit_card',
      origin: 'https://payments.onegate.co.za',
    });
    const owner = await createTestUser();
    await makeActive(owner.user.orgId, { plan: 'growth', billingCycle: 'monthly', startDays: -10, endDays: 20 });

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'plan-change-preview-checkout')
      .send({ plan: 'pro', billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.checkout.planChange).toEqual(expect.objectContaining({ type: 'upgrade', creditDays: 9 }));
    expect(res.body.account.organization.plan).toBe('growth');
  });
});
