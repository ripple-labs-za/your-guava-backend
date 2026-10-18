// Reconciliation: provider-response parsing, session claims and leases, failures, and the pending-payment sweeper.
// Moved from billingPayments.service.js by BE-11-T04; successful settlement evicts only the paying organisation.
const { clearApiCache } = require('../../middleware/cache.middleware');
const mongoose = require('mongoose');
const PaymentSession = require('../../models/PaymentSession.model');
const paymentProvider = require('../paymentProvider.service');
const { invalidateFutureForecastsForOrg } = require('./periods');
const { normalizePaymentReference, invalidPaymentReference, paymentSessionNotFound } = require('./sessions');
const { applyPlanPayment, applyCreditPayment, cardDetailsFromTransaction, revokeUnusedPackCredits } = require('./fulfilment');

const PROVIDER_LABELS = { paystack: 'Paystack', onegate: 'OneGate', mock: 'mock billing' };
const providerLabel = (name) => {
  const key = String(name || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, key) ? PROVIDER_LABELS[key] : 'the payment provider';
};

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
  const txAmount = Number(transaction.requestedAmount ?? transaction.amount ?? 0);
  const txCurrency = String(transaction.currency || transaction.currency_code || '').toUpperCase();
  return (
    txReference === paymentSession.reference &&
    Math.abs(txAmount - paymentSession.amount) < 0.01 &&
    Number(transaction.amount) >= txAmount - 0.01 &&
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

const observedFields = (transaction) => ({
  providerStatus: transaction ? String(transaction.status || 'unknown').slice(0, 40) : 'not_found',
  ...(transaction ? { providerPayload: { transaction: safeProviderPayload(transaction) } } : {}),
});

const holdForAttention = async (paymentSession, transaction, reason) => {
  console.error(`[billing] payment ${paymentSession.reference} (org ${paymentSession.orgId}) needs manual attention: ${reason}`);
  const held = await PaymentSession.findOneAndUpdate(
    { _id: paymentSession._id, status: 'processing', processingStartedAt: paymentSession.processingStartedAt },
    {
      $set: {
        ...observedFields(transaction), status: 'needs_attention', failedAt: new Date(),
        providerReason: String(reason).slice(0, 500),
      },
      $unset: { processingStartedAt: 1 },
    },
    { new: true, runValidators: true }
  );
  return held || PaymentSession.findById(paymentSession._id);
};

/** Bind before granting: the unique provider/id index prevents a second session consuming the capture. */
const bindProviderTransaction = async (paymentSession, transaction) => {
  const id = providerTransactionId(transaction);
  if (!id) return true;
  try {
    const bound = await PaymentSession.findOneAndUpdate(
      { _id: paymentSession._id, status: 'processing', processingStartedAt: paymentSession.processingStartedAt },
      { $set: { providerTransactionId: id } },
      { new: true, runValidators: true }
    );
    if (!bound) throw new Error('Payment session changed while fulfillment was starting');
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
};

const reconcilePaidSession = async (paymentSession) => {
  const transaction = await paymentProvider.providerForSession(paymentSession).lookupGatewayTransaction(paymentSession.reference);
  const status = String(transaction?.status || '').toLowerCase();
  if (status !== 'reversed') return paymentSession;
  const session = await mongoose.startSession();
  let reversed;
  try {
    // The status guard and withdrawal commit together, so a failed withdrawal remains retryable.
    await session.withTransaction(async () => {
      reversed = await PaymentSession.findOneAndUpdate(
        { _id: paymentSession._id, status: 'paid' },
        {
          $set: {
            status: 'reversed', reversedAt: new Date(), providerStatus: status,
            providerReason: 'The provider reported this payment reversed (refund or chargeback)',
          },
        },
        { new: true, runValidators: true, session }
      );
      if (reversed?.kind === 'credits') await revokeUnusedPackCredits(reversed, session);
    });
  } finally {
    await session.endSession();
  }
  if (!reversed) return PaymentSession.findById(paymentSession._id);
  console.error(
    `[billing] payment ${reversed.reference} (org ${reversed.orgId}, ${reversed.kind}) was reversed by the provider;`,
    reversed.kind === 'credits' ? 'unspent pack credits were withdrawn' : 'the plan period was left in place for manual review'
  );
  return reversed;
};

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

const releaseProcessingSession = (sessionId, processingStartedAt, status = 'pending', reason, extraSet = {}) =>
  PaymentSession.findOneAndUpdate(
    { _id: sessionId, status: 'processing', processingStartedAt },
    {
      $set: {
        ...extraSet,
        status,
        ...(reason ? { providerReason: String(reason).slice(0, 500) } : {}),
        ...(status === 'failed' || status === 'cancelled' ? { failedAt: new Date() } : {}),
      },
      $unset: { processingStartedAt: 1 },
    },
    { new: true, runValidators: true }
  );

const reconcilePayment = async (reference, webhookPayload = null, options = {}) => {
  const { session: paymentSession, claimed } = await claimPaymentSession(
    reference,
    webhookPayload,
    options
  );
  if (!claimed) {
    if (options.recheckPaid && paymentSession?.status === 'paid') return reconcilePaidSession(paymentSession);
    return paymentSession;
  }

  let financialEffectApplied = false;
  let transaction;
  try {
    transaction = await paymentProvider
      .providerForSession(paymentSession)
      .lookupGatewayTransaction(reference);
    if (!validateTransactionForSession(paymentSession, transaction)) {
      if (transaction && isPaidTransaction(transaction)) {
        const amount = Number(transaction.requestedAmount ?? transaction.amount ?? 0);
        return holdForAttention(paymentSession, transaction,
          `Captured payment did not match this session: expected R${Number(paymentSession.amount).toFixed(2)} ` +
          `${paymentSession.currency || 'ZAR'} for ${paymentSession.reference}, provider reported R${amount.toFixed(2)} ` +
          `${String(transaction.currency || '?').toUpperCase()} for ${transaction.merchant_reference || transaction.reference || '?'}`);
      }
      await releaseProcessingSession(
        paymentSession._id,
        paymentSession.processingStartedAt,
        'pending',
        'Provider transaction did not match payment session',
        observedFields(transaction)
      );
      const err = new Error(`Payment could not be verified with ${providerLabel(paymentSession.provider)} yet`);
      err.statusCode = 202;
      throw err;
    }

    if (isPaidTransaction(transaction)) {
      if (!(await bindProviderTransaction(paymentSession, transaction))) {
        return holdForAttention(paymentSession, transaction,
          `Provider transaction ${providerTransactionId(transaction)} already settled another payment session`);
      }
      let result;
      try {
        result = paymentSession.kind === 'plan'
          ? await applyPlanPayment(paymentSession, transaction)
          : await applyCreditPayment(paymentSession, transaction);
      } catch (fulfillmentError) {
        await recordFulfillmentFailure(paymentSession, transaction, fulfillmentError)
          .catch(() => null);
        throw fulfillmentError;
      }
      financialEffectApplied = true;

      const shown = cardDetailsFromTransaction(transaction, paymentSession.provider);
      const card = shown?.brand || shown?.last4
        ? { ...(shown.brand ? { brand: shown.brand } : {}), ...(shown.last4 ? { last4: shown.last4 } : {}) }
        : null;

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
            ...(card ? { card } : {}),
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
      'pending',
      undefined,
      observedFields(transaction)
    );
  } catch (error) {
    if (error.statusCode !== 202) {
      await releaseProcessingSession(
        paymentSession._id,
        paymentSession.processingStartedAt,
        'pending',
        financialEffectApplied ? 'Fulfillment recorded; finalization will retry' : error.message,
        financialEffectApplied ? observedFields(transaction) : {}
      ).catch(() => null);
    }
    throw error;
  }
};

const reconcilePendingPayments = async ({
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
  const nonCaptureStatuses = ['failed', 'abandoned', 'not_found'];

  await PaymentSession.updateMany(
    {
      provider: { $in: hostedProviders }, status: 'pending', createdAt: { $lt: expiredBefore },
      $or: [
        { providerStatus: 'success' },
        { providerTransactionId: { $exists: true }, providerStatus: { $nin: nonCaptureStatuses } },
      ],
    },
    { $set: { status: 'needs_attention', failedAt: now, providerReason: 'A captured payment was still unapplied after 24 hours' } }
  );

  // Retire checkouts the customer abandoned. Nothing is lost by doing so: the
  // last observation was a known non-capture, or no transaction was bound. If
  // one settles late the return or webhook can still claim a cancelled session.
  await PaymentSession.updateMany(
    {
      provider: { $in: hostedProviders },
      status: 'pending',
      $or: [
        { providerStatus: { $in: nonCaptureStatuses } },
        { providerTransactionId: { $exists: false }, providerStatus: { $ne: 'success' } },
      ],
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
          // A declined card can be retried on the same reference during the session's first day.
          { status: 'failed', failedAt: { $lte: pendingBefore }, createdAt: { $gte: expiredBefore } },
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
        const reconciled = await reconcilePayment(candidate.reference);
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
  reconcilePayment, reconcilePendingPayments, reconcilePaidSession,
  providerLabel,
  // Deprecated compatibility aliases; new callers use the provider-neutral names.
  reconcileOneGatePayment: reconcilePayment,
  reconcilePendingOneGatePayments: reconcilePendingPayments,
};
