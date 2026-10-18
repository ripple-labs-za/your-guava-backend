const {
  setup,
  teardown,
  clearDB,
  createTestUser,
} = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const oneGate = require('../../src/services/onegate.service');
const {
  reconcileOneGatePayment,
  reconcilePendingOneGatePayments,
} = require('../../src/services/billingPayments.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const paidTransaction = (reference, amount = '899.00') => ({
  id: `provider-${reference}`,
  successful: 1,
  status: 'complete',
  amount,
  currency: 'ZAR',
  merchant_reference: reference,
});

// createdAt is an immutable managed timestamp, so ageing a session has to go
// through the driver rather than the model.
const backdateSession = (sessionId, createdAt) =>
  PaymentSession.collection.updateOne(
    { _id: sessionId },
    { $set: { createdAt, updatedAt: createdAt } }
  );

describe('captured payment fulfilment', () => {
  it('schedules a captured downgrade even when the org has outgrown the new plan', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          plan: 'pro',
          billingStatus: 'active',
          currentPeriodStart: new Date(Date.now() - 86_400_000),
          currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
        },
      }
    );
    // Growth allows three locations. A fourth cafe opened while the hosted
    // checkout page was still on screen must not strand the customer's money.
    await Cafe.create([
      { name: 'Extra Cafe One', orgId: owner.user.orgId },
      { name: 'Extra Cafe Two', orgId: owner.user.orgId },
      { name: 'Extra Cafe Three', orgId: owner.user.orgId },
    ]);

    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'plan',
      reference: 'over-capacity-downgrade-payment',
      amount: 899,
      currency: 'ZAR',
      plan: 'growth',
      billingCycle: 'monthly',
    });
    jest
      .spyOn(oneGate, 'lookupGatewayTransaction')
      .mockResolvedValue(paidTransaction(session.reference));

    const reconciled = await reconcileOneGatePayment(session.reference);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(reconciled.status).toBe('paid');
    expect(org.plan).toBe('pro');
    expect(org.pendingPlanChange).toEqual(expect.objectContaining({ plan: 'growth', billingCycle: 'monthly' }));
    const { applyDuePlanChange } = require('../../src/services/billingPayments.service');
    const applied = await applyDuePlanChange(org, new Date(org.currentPeriodEnd.getTime() + 1000));
    expect(applied.plan).toBe('growth');
    expect(applied.billingStatus).toBe('active');
  });

  it('moves a payment that cannot be fulfilled to a terminal, visible state', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'plan',
      reference: 'unfulfillable-plan-payment',
      amount: 899,
      currency: 'ZAR',
      plan: 'growth',
      billingCycle: 'monthly',
    });
    jest
      .spyOn(oneGate, 'lookupGatewayTransaction')
      .mockResolvedValue(paidTransaction(session.reference));
    // Nothing left to apply the payment to: a permanent fulfilment failure.
    await Organization.deleteOne({ _id: owner.user.orgId });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await reconcileOneGatePayment(session.reference).catch(() => null);
    }

    const stranded = await PaymentSession.findById(session._id).lean();
    expect(stranded.status).toBe('needs_attention');
    expect(stranded.providerReason).toMatch(/organization not found/i);

    // Terminal means the sweeper stops burning provider calls on it: aged past
    // the sweep threshold it is still never picked up.
    await backdateSession(session._id, new Date(Date.now() - 5 * 60_000));
    const summary = await reconcilePendingOneGatePayments({ minAgeMs: 0 });
    expect(summary.scanned).toBe(0);
  });
});

describe('abandoned checkout sessions', () => {
  it('expires an abandoned pending session instead of sweeping it forever', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'abandoned-checkout-session',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });
    await backdateSession(session._id, new Date(Date.now() - 25 * 60 * 60 * 1000));
    const lookup = jest.spyOn(oneGate, 'lookupGatewayTransaction');

    const summary = await reconcilePendingOneGatePayments({ minAgeMs: 0 });

    expect(lookup).not.toHaveBeenCalled();
    expect(summary.scanned).toBe(0);
    const expired = await PaymentSession.findById(session._id).lean();
    expect(expired.status).toBe('cancelled');
    expect(expired.providerReason).toMatch(/expired/i);
  });

  it('still settles an expired session if the provider later confirms the payment', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'late-settled-checkout-session',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
      status: 'cancelled',
      providerReason: 'Checkout expired without payment',
    });
    jest
      .spyOn(oneGate, 'lookupGatewayTransaction')
      .mockResolvedValue(paidTransaction(session.reference, '99.00'));

    const reconciled = await reconcileOneGatePayment(session.reference);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(reconciled.status).toBe('paid');
    expect(org.aiCredits.bonus).toBe(500);
  });
});

describe('mock credit purchases', () => {
  // The mock path did a bare $inc with no session and no reference, so a
  // double-click, a retried request or a refreshed tab granted the pack again.
  // Real purchases have been idempotent since fulfilledPaymentReferences
  // existed; only the path used for testing and demos was not.
  const buy = (request, token, key) =>
    request
      .post('/api/account/ai-credits')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ credits: 500 });

  it('grants the pack once when the same key is replayed', async () => {
    const supertest = require('supertest');
    const { app } = require('../setup');
    const request = supertest(app);
    const { token, user } = await createTestUser();

    const before = await Organization.findById(user.orgId).lean();
    const first = await buy(request, token, 'mock-credits-replay');
    const second = await buy(request, token, 'mock-credits-replay');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const after = await Organization.findById(user.orgId).lean();
    const granted = (after.aiCredits?.bonus || 0) - (before.aiCredits?.bonus || 0);
    const pack = first.body.purchase.credits;
    expect(pack).toBeGreaterThan(0);
    expect(granted).toBe(pack);

    const sessions = await PaymentSession.find({ orgId: user.orgId, kind: 'credits' }).lean();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].provider).toBe('mock');
    expect(sessions[0].status).toBe('paid');
    expect(sessions[0].providerTransactionId).toEqual(expect.stringContaining('mock'));
  });

  it('grants twice for two genuinely different purchases', async () => {
    const supertest = require('supertest');
    const { app } = require('../setup');
    const request = supertest(app);
    const { token, user } = await createTestUser();

    const before = await Organization.findById(user.orgId).lean();
    const first = await buy(request, token, 'mock-credits-one');
    const second = await buy(request, token, 'mock-credits-two');

    const after = await Organization.findById(user.orgId).lean();
    const granted = (after.aiCredits?.bonus || 0) - (before.aiCredits?.bonus || 0);
    expect(granted).toBe(first.body.purchase.credits + second.body.purchase.credits);
    expect(await PaymentSession.countDocuments({ orgId: user.orgId, kind: 'credits' })).toBe(2);
  });

  it('still works for a client that sends no idempotency key', async () => {
    // Nothing in the product requires one today, and a purchase that 400s
    // because a header is missing is a worse failure than a duplicate.
    const supertest = require('supertest');
    const { app } = require('../setup');
    const request = supertest(app);
    const { token, user } = await createTestUser();

    const res = await request
      .post('/api/account/ai-credits')
      .set('Authorization', `Bearer ${token}`)
      .send({ credits: 500 });

    expect(res.status).toBe(200);
    expect(res.body.purchase.provider).toBe('mock');
    const org = await Organization.findById(user.orgId).lean();
    expect(org.aiCredits.bonus).toBeGreaterThan(0);
  });
});
