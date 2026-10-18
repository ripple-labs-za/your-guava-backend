// Reconciliation: provider-response parsing, session claims and leases, failures, and the pending-payment sweeper.
// Moved from billingPayments.service.js by BE-11-T04; successful settlement evicts only the paying organisation.
const { clearApiCache } = require('../../middleware/cache.middleware');
const PaymentSession = require('../../models/PaymentSession.model');
const paymentProvider = require('../paymentProvider.service');
const { invalidateFutureForecastsForOrg } = require('./periods');
const { normalizePaymentReference, invalidPaymentReference, paymentSessionNotFound } = require('./sessions');
const { applyPlanPayment, applyCreditPayment } = require('./fulfilment');

const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_RECONCILIATION_AGE_MS = 2 * 60 * 1000;
const DEFAULT_RECONCILIATION_BATCH_SIZE = 20;
// A handful of retries absorbs a transient database or concurrency failure;
// beyond that the failure is structural and hiding it in a retry loop is worse
// than surfacing it.
const MAX_FULFILLMENT_FAILURES = 3;
// A checkout the customer never completed must stop consuming sweep slots, or
// a genuinely paid session queued behind them waits minutes to be reconciled.
const PENDING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const transactionSuccessFlag = (transaction) =>
  transaction?.successful ?? transaction?.success;

const isExplicitSuccess = (value) => [true, 1, '1'].includes(value);
const isExplicitFailure = (value) => [false, 0, '0'].includes(value);

const isPaidTransaction = (transaction) => {
  const status = String(transaction?.status || '').toLowerCase();
  const success = transactionSuccessFlag(transaction);
  if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) return false;
  if (isExplicitFailure(success)) return false;
  return isExplicitSuccess(success) || status === 'complete';
};

const isFailedTransaction = (transaction) => {
  const status = String(transaction?.status || '').toLowerCase();
  return ['failed', 'cancelled', 'canceled', 'error'].includes(status) ||
    isExplicitFailure(transactionSuccessFlag(transaction));
};

const validateTransactionForSession = (paymentSession, transaction) => {
  if (!transaction) return false;
  const txReference = transaction.merchant_reference || transaction.reference;
  const txAmount = Number(transaction.amount || 0);
  const txCurrency = String(transaction.currency || transaction.currency_code || '').toUpperCase();
  return (
    txReference === paymentSession.reference &&
    Math.abs(txAmount - paymentSession.amount) < 0.01 &&
    (!txCurrency || txCurrency === String(paymentSession.currency || 'ZAR').toUpperCase())
  );
};

const providerTransactionId = (transaction) => String(
  transaction?.callpay_transaction_id || transaction?.id || ''
);

const safeProviderPayload = (transaction) => ({
  id: providerTransactionId(transaction) || undefined,
  status: transaction?.status,
  successful: transaction?.successful ?? transaction?.success,
  amount: transaction?.amount,
  currency: transaction?.currency || transaction?.currency_code,
  merchant_reference: transaction?.merchant_reference || transaction?.reference,
  gateway_reference: transaction?.gateway_reference,
});

const safeWebhookPayload = (payload) => {
  if (!payload) return undefined;
  return {
    merchant_reference: payload.merchant_reference || payload.reference,
    status: payload.status,
    successful: payload.successful ?? payload.success,
  };
};

const sessionFieldsFromTransaction = (transaction) => ({
  providerTransactionId: providerTransactionId(transaction) || undefined,
  gatewayReference: transaction?.gateway_reference,
  providerStatus: transaction?.status,
  providerReason: transaction?.reason,
  providerPayload: { transaction: safeProviderPayload(transaction) },
});

const claimPaymentSession = async (reference, webhookPayload, { orgId } = {}) => {
  // Defence in depth: even though callers normalise, this is the last point
  // before an attacker-influenced value reaches a database filter.
  const safeReference = normalizePaymentReference(reference);
  if (!safeReference) throw invalidPaymentReference();
  const lookup = { reference: safeReference, ...(orgId ? { orgId } : {}) };
  const existing = await PaymentSession.findOne(lookup);
  if (!existing) throw paymentSessionNotFound();
  if (existing.status === 'paid') return { session: existing, claimed: false };
  if (existing.initializationStatus === 'initializing') {
    return { session: existing, claimed: false };
  }

  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  const claimed = await PaymentSession.findOneAndUpdate(
    {
      _id: existing._id,
      initializationStatus: { $ne: 'initializing' },
      $or: [
        { status: { $in: ['pending', 'failed', 'cancelled'] } },
        { status: 'processing', processingStartedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'processing',
        processingStartedAt: new Date(),
        ...(webhookPayload ? { providerPayload: { webhook: safeWebhookPayload(webhookPayload) } } : {}),
      },
      $inc: { fulfillmentAttempts: 1 },
      $unset: { failedAt: 1 },
    },
    { new: true, runValidators: true }
  );

  if (claimed) return { session: claimed, claimed: true };
  return { session: await PaymentSession.findById(existing._id), claimed: false };
};

/**
 * Records a capture that could not be applied.
 *
 * A confirmed capture with no plan or credits delivered is money taken for
 * nothing, and releasing it back to `pending` makes the 60-second sweeper retry
 * the same failure forever with no dead-letter state and no alert. After a
 * bounded number of genuine fulfilment failures the session becomes terminal
 * and visible instead, so a person can refund or fix it.
 */
const recordFulfillmentFailure = async (paymentSession, transaction, error) => {
  const reason = String(error?.message || 'Fulfillment failed').slice(0, 500);
  const failed = await PaymentSession.findOneAndUpdate(
    {
      _id: paymentSession._id,
      status: 'processing',
      processingStartedAt: paymentSession.processingStartedAt,
    },
    {
      $inc: { fulfillmentFailures: 1 },
      $set: { ...sessionFieldsFromTransaction(transaction), providerReason: reason },
    },
    { new: true, runValidators: true }
  );
  // A newer worker owns the lease; it will record its own outcome.
  if (!failed) return null;

  if ((failed.fulfillmentFailures || 0) < MAX_FULFILLMENT_FAILURES) {
    return releaseProcessingSession(
      failed._id,
      paymentSession.processingStartedAt,
      'pending',
      reason
    );
  }

  console.error(
    `[billing] captured payment ${failed.reference} could not be fulfilled after`,
    `${failed.fulfillmentFailures} attempts and needs manual attention:`,
    reason
  );
  return PaymentSession.findOneAndUpdate(
    {
      _id: failed._id,
      status: 'processing',
      processingStartedAt: paymentSession.processingStartedAt,
    },
    {
      $set: { status: 'needs_attention', failedAt: new Date(), providerReason: reason },
      $unset: { processingStartedAt: 1 },
    },
    { new: true, runValidators: true }
  );
};

const releaseProcessingSession = (sessionId, processingStartedAt, status = 'pending', reason) =>
  PaymentSession.findOneAndUpdate(
    { _id: sessionId, status: 'processing', processingStartedAt },
    {
      $set: {
        status,
        ...(reason ? { providerReason: String(reason).slice(0, 500) } : {}),
        ...(status === 'failed' || status === 'cancelled' ? { failedAt: new Date() } : {}),
      },
      $unset: { processingStartedAt: 1 },
    },
    { new: true, runValidators: true }
  );

const reconcileOneGatePayment = async (reference, webhookPayload = null, options = {}) => {
  const { session: paymentSession, claimed } = await claimPaymentSession(
    reference,
    webhookPayload,
    options
  );
  if (!claimed) return paymentSession;

  let financialEffectApplied = false;
  try {
    const transaction = await paymentProvider
      .providerForSession(paymentSession)
      .lookupGatewayTransaction(reference);
    if (!validateTransactionForSession(paymentSession, transaction)) {
      await releaseProcessingSession(
        paymentSession._id,
        paymentSession.processingStartedAt,
        'pending',
        'Provider transaction did not match payment session'
      );
      const err = new Error('Payment could not be verified with OneGate');
      err.statusCode = 202;
      throw err;
    }

    if (isPaidTransaction(transaction)) {
      let result;
      try {
        result = paymentSession.kind === 'plan'
          ? await applyPlanPayment(paymentSession, transaction)
          : await applyCreditPayment(paymentSession);
      } catch (fulfillmentError) {
        await recordFulfillmentFailure(paymentSession, transaction, fulfillmentError)
          .catch(() => null);
        throw fulfillmentError;
      }
      financialEffectApplied = true;

      const paid = await PaymentSession.findOneAndUpdate(
        {
          _id: paymentSession._id,
          status: 'processing',
          processingStartedAt: paymentSession.processingStartedAt,
        },
        {
          $set: {
            ...sessionFieldsFromTransaction(transaction),
            status: 'paid',
            paidAt: new Date(),
          },
          $unset: { processingStartedAt: 1, failedAt: 1 },
        },
        { new: true, runValidators: true }
      );
      if (!paid) throw new Error('Payment session changed while fulfillment was completing');

      if (result.planChanged) {
        invalidateFutureForecastsForOrg(paymentSession.orgId).catch((error) => {
          console.error('[billing] forecast invalidation failed:', error.message);
        });
      }
      // Only the transition to paid evicts; callback replays return before this branch.
      clearApiCache({ orgId: paymentSession.orgId });
      return paid;
    }

    if (isFailedTransaction(transaction)) {
      const failedStatus = String(transaction?.status || '').toLowerCase().includes('cancel')
        ? 'cancelled'
        : 'failed';
      return PaymentSession.findOneAndUpdate(
        {
          _id: paymentSession._id,
          status: 'processing',
          processingStartedAt: paymentSession.processingStartedAt,
        },
        {
          $set: {
            ...sessionFieldsFromTransaction(transaction),
            status: failedStatus,
            failedAt: new Date(),
          },
          $unset: { processingStartedAt: 1 },
        },
        { new: true, runValidators: true }
      );
    }

    return releaseProcessingSession(
      paymentSession._id,
      paymentSession.processingStartedAt,
      'pending'
    );
  } catch (error) {
    if (error.statusCode !== 202) {
      await releaseProcessingSession(
        paymentSession._id,
        paymentSession.processingStartedAt,
        'pending',
        financialEffectApplied ? 'Fulfillment recorded; finalization will retry' : error.message
      ).catch(() => null);
    }
    throw error;
  }
};

const reconcilePendingOneGatePayments = async ({
  now = new Date(),
  minAgeMs = DEFAULT_RECONCILIATION_AGE_MS,
  limit = DEFAULT_RECONCILIATION_BATCH_SIZE,
  concurrency = 4,
} = {}) => {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RECONCILIATION_BATCH_SIZE, 100));
  const boundedConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 10));
  const pendingBefore = new Date(now.getTime() - Math.max(30_000, Number(minAgeMs) || 0));
  const staleProcessingBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const expiredBefore = new Date(now.getTime() - PENDING_SESSION_TTL_MS);
  const hostedProviders = paymentProvider.hostedProviderNames();

  // Retire checkouts the customer abandoned. Nothing is lost by doing so: the
  // provider never recorded a transaction against them, and if one ever settles
  // late the return or webhook can still claim a cancelled session.
  await PaymentSession.updateMany(
    {
      provider: { $in: hostedProviders },
      status: 'pending',
      providerTransactionId: { $exists: false },
      createdAt: { $lt: expiredBefore },
    },
    {
      $set: {
        status: 'cancelled',
        failedAt: now,
        providerReason: 'Checkout expired without payment',
      },
    }
  );

  const sessions = await PaymentSession.find({
    // Every hosted provider needs reconciling, not just the original one. A
    // name hard-coded here silently strands the other provider's payments.
    provider: { $in: hostedProviders },
    $and: [
      {
        $or: [
          { initializationStatus: 'ready' },
          { initializationStatus: { $exists: false } },
        ],
      },
      {
        $or: [
          {
            status: 'pending',
            updatedAt: { $lte: pendingBefore },
            createdAt: { $gte: expiredBefore },
          },
          { status: 'processing', processingStartedAt: { $lt: staleProcessingBefore } },
        ],
      },
    ],
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(boundedLimit)
    .select('reference')
    .lean();

  const summary = { scanned: sessions.length, paid: 0, pending: 0, failed: 0, errors: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < sessions.length) {
      const index = cursor;
      cursor += 1;
      const candidate = sessions[index];
      try {
        const reconciled = await reconcileOneGatePayment(candidate.reference);
        if (reconciled?.status === 'paid') summary.paid += 1;
        else if (['failed', 'cancelled'].includes(reconciled?.status)) summary.failed += 1;
        else summary.pending += 1;
      } catch (error) {
        if (error.statusCode === 202) summary.pending += 1;
        else summary.errors += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(boundedConcurrency, sessions.length) }, () => worker())
  );
  return summary;
};

module.exports = {
  isPaidTransaction, isFailedTransaction, validateTransactionForSession, claimPaymentSession, recordFulfillmentFailure, releaseProcessingSession,
  reconcileOneGatePayment, reconcilePendingOneGatePayments,
};
