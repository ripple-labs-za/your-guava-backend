const crypto = require('crypto');
const axios = require('axios');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const {
  reconcileOneGatePayment,
  reconcilePendingOneGatePayments,
} = require('../../src/services/billingPayments.service');
const { verifyResponse } = require('../fixtures/paystack');

const request = supertest(app);
const ENV_KEYS = ['PAYMENT_PROVIDER', 'PAYSTACK_SECRET_KEY'];
const HOUR = 60 * 60 * 1000;
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

const verifyReturns = (...bodies) => {
  const spy = jest.spyOn(axios, 'get');
  bodies.forEach((body) => spy.mockResolvedValueOnce({ data: body }));
  return spy;
};
const creditSession = (owner, reference, extra = {}) => PaymentSession.create({
  orgId: owner.user.orgId,
  userId: owner.user.id,
  provider: 'paystack',
  kind: 'credits',
  reference,
  amount: 99,
  currency: 'ZAR',
  credits: 500,
  ...extra,
});
const planSession = (owner, reference) => PaymentSession.create({
  orgId: owner.user.orgId,
  userId: owner.user.id,
  provider: 'paystack',
  kind: 'plan',
  reference,
  amount: 899,
  currency: 'ZAR',
  plan: 'growth',
  billingCycle: 'monthly',
});
const age = (sessionId, fields) => PaymentSession.collection.updateOne({ _id: sessionId }, { $set: fields });
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
const signed = (body) => {
  const raw = JSON.stringify(body);
  return { raw, signature: crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex') };
};

describe('Paystack in-flight statuses (billing-1)', () => {
  it.each(['abandoned', 'ongoing', 'pending', 'processing', 'queued'])(
    'a %s checkout stays pending, records what Paystack said, and settles when the sweeper re-checks it',
    async (status) => {
      const owner = await createTestUser();
      const session = await creditSession(owner, `inflight-${status}`);
      verifyReturns(
        verifyResponse(status, { reference: session.reference, amountRand: 99 }),
        verifyResponse('success', { reference: session.reference, amountRand: 99, id: 7000001 })
      );

      const first = await reconcileOneGatePayment(session.reference);
      expect(first.status).toBe('pending');
      expect(first.providerStatus).toBe(status);
      expect(first.failedAt).toBeUndefined();

      await age(session._id, { updatedAt: minutesAgo(5) });
      const summary = await reconcilePendingOneGatePayments({ minAgeMs: 0 });

      expect(summary.paid).toBe(1);
      expect((await PaymentSession.findById(session._id).lean()).status).toBe('paid');
      expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
    }
  );

  it('re-checks a recently failed checkout and settles it if the customer paid on retry', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'failed-then-paid');
    verifyReturns(
      verifyResponse('failed', { reference: session.reference, amountRand: 99 }),
      verifyResponse('success', { reference: session.reference, amountRand: 99, id: 7000002 })
    );

    expect((await reconcileOneGatePayment(session.reference)).status).toBe('failed');
    await age(session._id, { updatedAt: minutesAgo(5), failedAt: minutesAgo(5) });
    const summary = await reconcilePendingOneGatePayments({ minAgeMs: 0 });

    expect(summary.paid).toBe(1);
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
  });

  it('asks Paystack to retry the webhook when reconciliation fails for a real reason', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'webhook-retry');
    jest.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('socket hang up'), { response: { status: 500, data: {} } }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const { raw, signature } = signed({ event: 'charge.success', data: { reference: session.reference } });

    const res = await request
      .post('/api/account/payments/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(raw);

    expect(res.status).toBe(500);
    expect((await PaymentSession.findById(session._id).lean()).status).toBe('pending');
  });
});

describe('captures that do not match the session (billing-2)', () => {
  it('holds a capture for the wrong amount as needs_attention and never expires it as unpaid', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'mismatched-capture');
    const lookup = verifyReturns(verifyResponse('success', { reference: session.reference, amountRand: 120, id: 7000003 }));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});

    const held = await reconcileOneGatePayment(session.reference);

    expect(held.status).toBe('needs_attention');
    expect(held.providerReason).toMatch(/did not match/i);
    expect(held.providerReason).toMatch(/120\.00/);
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/mismatched-capture/);
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);

    await age(session._id, { createdAt: new Date(Date.now() - 25 * HOUR) });
    await reconcilePendingOneGatePayments({ minAgeMs: 0 });
    expect((await PaymentSession.findById(session._id).lean()).status).toBe('needs_attention');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('settles a fee-inclusive capture against the amount that was requested', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'fee-inclusive-capture');
    verifyReturns(verifyResponse('success', {
      reference: session.reference, amountRand: 101.73, requestedRand: 99, id: 7000004,
    }));

    expect((await reconcileOneGatePayment(session.reference)).status).toBe('paid');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
  });

  it('escalates a pending session whose last verify saw a capture instead of cancelling it after 24 hours', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'legacy-captured', { providerStatus: 'success' });
    await age(session._id, { createdAt: new Date(Date.now() - 25 * HOUR) });
    const lookup = jest.spyOn(axios, 'get');

    await reconcilePendingOneGatePayments({ minAgeMs: 0 });

    const after = await PaymentSession.findById(session._id).lean();
    expect(after.status).toBe('needs_attention');
    expect(after.providerReason).toMatch(/still unapplied after 24 hours/i);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('still expires a checkout that Paystack last reported abandoned (regression guard)', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'abandoned-expired', { providerStatus: 'abandoned' });
    await age(session._id, { createdAt: new Date(Date.now() - 25 * HOUR) });

    await reconcilePendingOneGatePayments({ minAgeMs: 0 });

    expect((await PaymentSession.findById(session._id).lean()).status).toBe('cancelled');
  });
});

  describe('transaction identity (WS-05-T03)', () => {
    it('return, webhook and sweeper reconciliation of one capture grant exactly once', async () => {
      const owner = await createTestUser();
      const session = await creditSession(owner, 'three-concurrent-paths');
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: verifyResponse('success', { reference: session.reference, amountRand: 99, id: 9100001 }),
      });

      await Promise.all(Array.from({ length: 3 }, () => reconcileOneGatePayment(session.reference)));

      const stored = await PaymentSession.findById(session._id).lean();
      const org = await Organization.findById(owner.user.orgId).select('+fulfilledPaymentReferences').lean();
      expect(stored.status).toBe('paid');
      expect(stored.processingStartedAt).toBeUndefined();
      expect(org.aiCredits.bonus).toBe(500);
      expect(org.fulfilledPaymentReferences.filter((ref) => ref === session.reference)).toHaveLength(1);
    });

    it('retries a database failure after binding without conflicting with its own transaction id', async () => {
      const owner = await createTestUser();
      const session = await creditSession(owner, 'retry-own-binding');
      jest.spyOn(axios, 'get').mockResolvedValue({
        data: verifyResponse('success', { reference: session.reference, amountRand: 99, id: 9100002 }),
      });
      jest.spyOn(Organization, 'findOneAndUpdate').mockReturnValueOnce({
        select: jest.fn().mockRejectedValueOnce(new Error('temporary grant failure')),
      });

      await expect(reconcileOneGatePayment(session.reference)).rejects.toThrow('temporary grant failure');
      const pending = await PaymentSession.findById(session._id).lean();
      expect(pending.providerTransactionId).toBe('9100002');
      expect(pending.status).toBe('pending');
      expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);

      expect((await reconcileOneGatePayment(session.reference)).status).toBe('paid');
      expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
    });

  it('two sessions cannot settle one Paystack transaction id', async () => {
    await PaymentSession.init();
    const owner = await createTestUser();
    const first = await creditSession(owner, 'identity-first');
    const second = await creditSession(owner, 'identity-second');
    jest.spyOn(axios, 'get').mockImplementation(async (url) => {
      const reference = decodeURIComponent(String(url).split('/').pop());
      return { data: verifyResponse('success', { reference, amountRand: 99, id: 998877 }) };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const settled = await reconcileOneGatePayment(first.reference);
    const duplicate = await reconcileOneGatePayment(second.reference);

    expect(settled.status).toBe('paid');
    expect(settled.providerTransactionId).toBe('998877');
    expect(duplicate.status).toBe('needs_attention');
    expect(duplicate.providerReason).toMatch(/already settled another payment session/i);
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
  });
});

describe('card details (billing-10, WS-05-T04)', () => {
  it('stores brand, last4 and expiry under the provider that took the payment, never the reusable authorization', async () => {
    const owner = await createTestUser();
    const session = await planSession(owner, 'card-details-plan');
    verifyReturns(verifyResponse('success', { reference: session.reference, amountRand: 899, id: 7000005 }));
    // The label must come from the session, not from whichever provider the environment names now.
    process.env.PAYMENT_PROVIDER = 'onegate';

    const paid = await reconcileOneGatePayment(session.reference);

    const org = await Organization.findById(owner.user.orgId).lean();
    const stored = await PaymentSession.findById(session._id).lean();
    expect(paid.status).toBe('paid');
    expect(org.paymentMethod).toEqual({ brand: 'visa', last4: '4081', expiresAt: '12/30', provider: 'paystack' });
    expect(stored.card).toEqual({ brand: 'visa', last4: '4081' });
    expect(JSON.stringify(stored)).not.toMatch(/AUTH_|SIG_|408408|CUS_/);
    expect(JSON.stringify(org)).not.toMatch(/AUTH_|SIG_|408408/);
  });
});

  describe('reversals (billing-19)', () => {
    const settle = async (session, id) => {
    verifyReturns(
      verifyResponse('success', { reference: session.reference, amountRand: session.amount, id }),
      verifyResponse('reversed', { reference: session.reference, amountRand: session.amount, id })
    );
      await reconcileOneGatePayment(session.reference);
    };

    it('keeps a reversal retryable when withdrawing credits fails before commit', async () => {
      const owner = await createTestUser();
      const session = await creditSession(owner, 'retry-reversal-write');
      await settle(session, 9100003);
      jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(Organization, 'updateOne').mockRejectedValueOnce(new Error('temporary withdrawal failure'));

      await expect(reconcileOneGatePayment(session.reference, null, { recheckPaid: true }))
        .rejects.toThrow('temporary withdrawal failure');
      expect((await PaymentSession.findById(session._id).lean()).status).toBe('paid');
      expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);

      axios.get.mockResolvedValue({ data: verifyResponse('reversed', {
        reference: session.reference, amountRand: 99, id: 9100003,
      }) });
      expect((await reconcileOneGatePayment(session.reference, null, { recheckPaid: true })).status).toBe('reversed');
      expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);
    });

    it('concurrent refund webhooks never withdraw a second pack from the balance', async () => {
      const owner = await createTestUser();
      const session = await creditSession(owner, 'concurrent-refunds');
      await settle(session, 9100004);
      await Organization.updateOne({ _id: owner.user.orgId }, { $inc: { 'aiCredits.bonus': 1000 } });
      jest.spyOn(console, 'error').mockImplementation(() => {});
      axios.get.mockResolvedValue({ data: verifyResponse('reversed', {
        reference: session.reference, amountRand: 99, id: 9100004,
      }) });

      await Promise.all(Array.from({ length: 3 }, () =>
        reconcileOneGatePayment(session.reference, null, { recheckPaid: true })));
      expect((await PaymentSession.findById(session._id).lean()).status).toBe('reversed');
      expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(1000);
    });

  it('marks a reversed credit pack reversed and withdraws its unused credits', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'reversed-pack');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await settle(session, 7000006);
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { 'aiCredits.bonusUsed': 200 } });

    const reversed = await reconcileOneGatePayment(
      session.reference,
      { reference: session.reference, status: 'refund.processed' },
      { recheckPaid: true }
    );

    expect(reversed.status).toBe('reversed');
    expect(reversed.reversedAt).toBeInstanceOf(Date);
    // 500 bought, 200 already spent: the 300 unspent are withdrawn, the spent 200 stay spent.
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(200);
  });

  it('records a reversed plan payment and flags it for review without cutting access', async () => {
    const owner = await createTestUser();
    const session = await planSession(owner, 'reversed-plan');
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    await settle(session, 7000007);

    const reversed = await reconcileOneGatePayment(
      session.reference,
      { reference: session.reference, status: 'charge.dispute.resolve' },
      { recheckPaid: true }
    );

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(reversed.status).toBe('reversed');
    expect(org.plan).toBe('growth');
    expect(org.billingStatus).toBe('active');
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/reversed-plan.*manual review/);
  });

  it('does not re-verify a paid session unless asked to', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'paid-no-recheck', { status: 'paid' });
    const lookup = jest.spyOn(axios, 'get');

    const result = await reconcileOneGatePayment(session.reference, { reference: session.reference, status: 'charge.success' });

    expect(result.status).toBe('paid');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('reads the original reference from a signed refund webhook and applies the reversal', async () => {
    const owner = await createTestUser();
    const session = await creditSession(owner, 'refund-webhook');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await settle(session, 7000008);
    const { raw, signature } = signed({
      event: 'refund.processed',
      data: { status: 'processed', transaction_reference: session.reference, amount: 9900, currency: 'ZAR' },
    });

    const res = await request
      .post('/api/account/payments/paystack/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(raw);

    expect(res.status).toBe(200);
    expect((await PaymentSession.findById(session._id).lean()).status).toBe('reversed');
  });

  it.each([{ bad: 'reference' }, ['array-reference'], 'a'.repeat(10_000)])(
    'ignores a hostile signed refund reference without a lookup (%#)', async (reference) => {
      const lookup = jest.spyOn(PaymentSession, 'findOne');
      const provider = jest.spyOn(axios, 'get');
      const { raw, signature } = signed({ event: 'refund.processed', data: { transaction_reference: reference } });
      const response = await request.post('/api/account/payments/paystack/webhook')
        .set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(raw);

      expect(response.status).toBe(200);
      expect(lookup).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    }
  );
});
