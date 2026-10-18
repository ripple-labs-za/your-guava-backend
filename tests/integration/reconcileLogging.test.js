const crypto = require('crypto');
const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const logger = require('../../src/utils/logger');
const PaymentSession = require('../../src/models/PaymentSession.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const oneGate = require('../../src/services/onegate.service');
const paystack = require('../../src/services/paystack.service');
const { reconcilePendingOneGatePayments } = require('../../src/services/billingPayments.service');
const { reconcileStaleUsageReservations } = require('../../src/services/usage.service');

const request = supertest(app);
const backdate = (sessionId, when) =>
  PaymentSession.collection.updateOne({ _id: sessionId }, { $set: { createdAt: when, updatedAt: when } });

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

describe('reconciliation failures are logged with what failed', () => {
  it('names the payment session, reference, provider and error when a sweep lookup fails', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'credits',
      reference: 'sweep-log-probe',
      amount: 99,
      currency: 'ZAR',
      credits: 500,
    });
    await backdate(session._id, new Date(Date.now() - 5 * 60000));
    jest.spyOn(oneGate, 'lookupGatewayTransaction')
      .mockRejectedValue(Object.assign(new Error('gateway timeout'), { code: 'ETIMEDOUT' }));
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const summary = await reconcilePendingOneGatePayments({ minAgeMs: 0 });

    expect(summary.errors).toBe(1);
    expect(error).toHaveBeenCalledWith('payment_reconcile_failed', expect.objectContaining({
      sessionId: String(session._id),
      reference: 'sweep-log-probe',
      provider: 'onegate',
      orgId: String(owner.user.orgId),
      errorMessage: 'gateway timeout',
      errorCode: 'ETIMEDOUT',
    }));
  });

  it('names the usage reservation and error when recovering it fails', async () => {
    const inserted = await UsageLedger.collection.insertOne({
      orgId: new mongoose.Types.ObjectId(),
      status: 'reserved',
      reservedAt: new Date(Date.now() - 60 * 60000),
      createdAt: new Date(Date.now() - 60 * 60000),
    });
    jest.spyOn(mongoose, 'startSession').mockRejectedValueOnce(new Error('transaction numbers unavailable'));
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});

    const summary = await reconcileStaleUsageReservations();

    expect(summary.errors).toBe(1);
    expect(error).toHaveBeenCalledWith('usage_reconcile_failed', expect.objectContaining({
      ledgerId: String(inserted.insertedId),
      errorMessage: 'transaction numbers unavailable',
    }));
  });

  it('logs a failed Paystack webhook reconciliation with the reference and request id', async () => {
    const previousKey = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_logging_probe';
    try {
      const owner = await createTestUser();
      await PaymentSession.create({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        provider: 'paystack',
        kind: 'credits',
        reference: 'paystack-log-probe',
        amount: 99,
        currency: 'ZAR',
        credits: 500,
      });
      jest.spyOn(paystack, 'lookupGatewayTransaction')
        .mockRejectedValue(Object.assign(new Error('paystack unreachable'), { code: 'ECONNRESET' }));
      const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
      const body = JSON.stringify({ event: 'charge.success', data: { reference: 'paystack-log-probe' } });
      const signature = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex');

      const res = await request
        .post('/api/account/payments/paystack/webhook')
        .set('Content-Type', 'application/json')
        .set('x-paystack-signature', signature)
        .send(body);

      expect(res.status).toBe(500);
      expect(error).toHaveBeenCalledWith('payment_webhook_reconcile_failed', expect.objectContaining({
        provider: 'paystack',
        reference: 'paystack-log-probe',
        event: 'charge.success',
        requestId: res.headers['x-request-id'],
        errorCode: 'ECONNRESET',
      }));
    } finally {
      if (previousKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = previousKey;
    }
  });
});
