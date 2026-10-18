const axios = require('axios');
const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const { verifyResponse } = require('../fixtures/paystack');

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

const session = (owner, reference, fields) => PaymentSession.create({
  orgId: owner.user.orgId, userId: owner.user.id, provider: 'paystack', reference, currency: 'ZAR', ...fields,
});
const credits = (owner, reference) => session(owner, reference, { kind: 'credits', amount: 99, credits: 500 });
const { reconcilePendingPayments, reconcilePayment } = require('../../src/services/billingPayments.service');

const agedCredits = async (owner, reference) => {
  const created = await credits(owner, reference);
  await PaymentSession.collection.updateOne({ _id: created._id }, { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } });
  return created;
};

describe('the sweeper over Paystack sessions whose return and webhook were lost', () => {
  it('holds a verified amount mismatch without granting credits', async () => {
    const owner = await createTestUser();
    await agedCredits(owner, 'sweep-mismatch');
    const lookup = jest.spyOn(axios, 'get').mockResolvedValue({
      data: verifyResponse('success', { reference: 'sweep-mismatch', amountRand: 120, id: 6300099 }),
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await reconcilePendingPayments({ minAgeMs: 0 });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await PaymentSession.findOne({ reference: 'sweep-mismatch' }).lean()).status).toBe('needs_attention');
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(0);
  });

  it.each([
    ['success', 'paid', 500],
    ['abandoned', 'pending', 0],
    ['failed', 'failed', 0],
    ['reversed', 'failed', 0],
  ])('a %s verify leaves the session %s and grants %d credits', async (status, stored, bonus) => {
    const owner = await createTestUser();
    await agedCredits(owner, `sweep-${status}`);
    jest.spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: verifyResponse(status, { reference: `sweep-${status}`, amountRand: 99, id: 6300001 }) });

    await reconcilePendingPayments({ minAgeMs: 0 });

    expect((await PaymentSession.findOne({ reference: `sweep-${status}` }).lean()).status).toBe(stored);
    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(bonus);
  });

  it('records not_found and keeps sweeping a session Paystack has never seen', async () => {
    const owner = await createTestUser();
    await agedCredits(owner, 'sweep-404');
    jest.spyOn(axios, 'get').mockRejectedValueOnce({ response: { status: 404 } });

    const summary = await reconcilePendingPayments({ minAgeMs: 0 });

    const stored = await PaymentSession.findOne({ reference: 'sweep-404' }).lean();
    expect(summary.pending).toBe(1);
    expect(stored.status).toBe('pending');
    expect(stored.providerStatus).toBe('not_found');
  });

  it('never double-grants a session the return settled a moment earlier', async () => {
    const owner = await createTestUser();
    await agedCredits(owner, 'sweep-after-return');
    const lookup = jest.spyOn(axios, 'get').mockResolvedValue({
      data: verifyResponse('success', { reference: 'sweep-after-return', amountRand: 99, id: 6300002 }),
    });
    await reconcilePayment('sweep-after-return');

    await reconcilePendingPayments({ minAgeMs: 0 });

    expect((await Organization.findById(owner.user.orgId).lean()).aiCredits.bonus).toBe(500);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
