const logger = require('../../utils/logger');
// Fulfilment: applying a paid plan or credit pack to the organisation, and the mock credit purchase.
// Moved from billingPayments.service.js by BE-11-T04; behaviour unchanged.
const Organization = require('../../models/Organization.model');
const PaymentSession = require('../../models/PaymentSession.model');
const { getPlan, nextMonthlyAnniversary } = require('../billingPlans.service');
const paymentProvider = require('../paymentProvider.service');
const { getPlanCapacity } = require('../planCapacity.service');
const { bonusUsedForCredits } = require('../usage.service');
const { planChangeForPayment, isScheduledChange, planChangeIsDue, invalidateFutureForecastsForOrg } = require('./periods');
const { normalizePaymentIdempotencyKey, generateReference, paymentRequestFingerprint, paymentInitiationError } = require('./sessions');

const cardDetailsFromTransaction = (transaction, provider) => {
  // Paystack reports the card under `authorization` with discrete fields.
  // OneGate returns a masked PAN inside its gateway response parameters, so the
  // brand and last four have to be picked out of loose strings.
  const authorization = transaction?.authorization;
  if (authorization?.last4 || authorization?.brand) {
    const brand = String(authorization.brand || '').trim().toLowerCase();
    const last4 = String(authorization.last4 || '').trim();
    const expiresAt = authorization.exp_month && authorization.exp_year
      ? `${String(authorization.exp_month).padStart(2, '0')}/${String(authorization.exp_year).slice(-2)}`
      : undefined;
    return {
      ...(brand ? { brand } : {}),
      ...(last4 ? { last4 } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      provider: provider || paymentProvider.providerName() || 'paystack',
    };
  }

  const params = transaction?.gateway_response_parameters || transaction?.gateway_response || {};
  if (typeof params !== 'object') return null;
  const maskedCard = String(params.card || params.Card || '');
  const last4Match = maskedCard.match(/(\d{4})\D*$/);
  const last4 = last4Match?.[1];
  const brand = String(params.cardName || params.card_name || params.cardBrand || '')
    .trim()
    .toLowerCase();

  if (!brand && !last4) return null;
  return {
    ...(brand ? { brand } : {}),
    ...(last4 ? { last4 } : {}),
    provider: provider || paymentProvider.providerName() || 'onegate',
  };
};

const appliedReferences = (org) => (org?.fulfilledPaymentReferences || []).map(String);

/**
 * Reports a plan that the organisation has already outgrown.
 *
 * Capacity is enforced before the customer is sent to checkout. Re-checking it
 * after the card has been captured could only ever refuse money that is already
 * taken, so an organisation that outgrew the plan while the checkout page was
 * open gets the plan it paid for and an operational warning instead. The
 * account payload already reports used-versus-included seats and locations, so
 * the owner sees the same overage and the ordinary limits stop it growing.
 */
const warnOnOverCapacityPlan = async (orgId, previousPlanId, nextPlanId) => {
  const previousPlan = getPlan(previousPlanId);
  const nextPlan = getPlan(nextPlanId);
  if (
    nextPlan.includedSeats >= previousPlan.includedSeats &&
    nextPlan.includedLocations >= previousPlan.includedLocations
  ) {
    return;
  }
  const capacity = await getPlanCapacity(orgId, nextPlan.id);
  if (!capacity.seats.exceeded && !capacity.locations.exceeded) return;
  logger.warn('org_over_capacity', { orgId: String(orgId), plan: nextPlan.id, seatsUsed: capacity.seats.used, seatsIncluded: capacity.seats.included, locationsUsed: capacity.locations.used, locationsIncluded: capacity.locations.included });
};

const planChangeConflictError = (pending) => {
  const err = new Error(
    `A plan change is already scheduled (${pending.plan} ${pending.billingCycle} from ` +
    `${new Date(pending.effectiveAt).toISOString()}); this payment needs a manual decision`
  );
  err.statusCode = 409;
  err.code = 'PLAN_CHANGE_ALREADY_SCHEDULED';
  return err;
};

const immediateChangeUpdate = (org, change, paymentMethod, now) => {
  const selectedPlan = getPlan(change.plan);
  const existingResetAt = org.aiCredits?.resetAt ? new Date(org.aiCredits.resetAt) : null;
  // D-019: a new or upgraded term gets a fresh allowance; a renewal keeps the live window.
  const resetCredits = change.type !== 'renewal' || !existingResetAt || existingResetAt <= now;
  const bonusUsed = bonusUsedForCredits(org);
  return {
    $set: {
      plan: selectedPlan.id,
      billingCycle: change.billingCycle,
      billingStatus: 'active',
      subscriptionStartedAt: org.subscriptionStartedAt || now,
      currentPeriodStart: change.currentPeriodStart,
      currentPeriodEnd: change.currentPeriodEnd,
      cancelAtPeriodEnd: false,
      ...(paymentMethod ? { paymentMethod } : {}),
      'aiCredits.included': selectedPlan.includedGuavaCredits ?? selectedPlan.includedAiCredits,
      ...(resetCredits
        ? {
            'aiCredits.bonusUsed': bonusUsed,
            'aiCredits.used': bonusUsed,
            'aiCredits.resetAt': nextMonthlyAnniversary(change.currentPeriodStart, now),
          }
        : {}),
    },
  };
};

const scheduledChangeUpdate = (change, paymentSession, paymentMethod, now) => ({
  $set: {
    pendingPlanChange: {
      plan: change.plan,
      billingCycle: change.billingCycle,
      effectiveAt: change.effectiveAt,
      periodEnd: change.currentPeriodEnd,
      reference: paymentSession.reference,
      scheduledAt: now,
    },
    cancelAtPeriodEnd: false,
    ...(paymentMethod ? { paymentMethod } : {}),
  },
});

const applyPlanPayment = async (paymentSession, transaction) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const org = await Organization.findById(paymentSession.orgId).select('+fulfilledPaymentReferences');
    if (!org) {
      const err = new Error('Organization not found');
      err.statusCode = 404;
      throw err;
    }
    if (appliedReferences(org).includes(paymentSession.reference)) {
      return { org, applied: false, planChanged: false, change: null };
    }
    const now = new Date();
    // A scheduled term whose start has passed is already paid for: start it before judging this payment
    // against it (the return URL, the webhook and the sweeper do not pass through the auth middleware).
    if (planChangeIsDue(org, now)) {
      await applyDuePlanChange(org.toObject(), now);
      continue;
    }
    const pending = org.pendingPlanChange;
    if (pending?.reference && pending.reference !== paymentSession.reference) throw planChangeConflictError(pending);

    const change = planChangeForPayment(org, paymentSession, now);
    const paymentMethod = cardDetailsFromTransaction(transaction, paymentSession.provider);
    const update = isScheduledChange(change)
      ? scheduledChangeUpdate(change, paymentSession, paymentMethod, now)
      : immediateChangeUpdate(org, change, paymentMethod, now);

    const updated = await Organization.findOneAndUpdate(
      { _id: org._id, __v: org.__v, fulfilledPaymentReferences: { $ne: paymentSession.reference } },
      { ...update, $addToSet: { fulfilledPaymentReferences: paymentSession.reference }, $inc: { __v: 1 } },
      { new: true, runValidators: true }
    ).select('+fulfilledPaymentReferences');

    if (updated) {
      const planChanged = updated.plan !== org.plan;
      if (planChanged) await warnOnOverCapacityPlan(org._id, org.plan, updated.plan).catch(() => null);
      return { org: updated, applied: true, planChanged, change };
    }
  }
  throw new Error('Could not apply plan payment after concurrent billing updates');
};

/**
 * Starts a scheduled (already paid) term once its start has passed. Called by the auth middleware on the
 * first request at or after `effectiveAt`; the filter on the reference makes concurrent callers apply it once.
 */
const applyDuePlanChange = async (org, now = new Date()) => {
  if (!planChangeIsDue(org, now)) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A reservation/refund can change purchased-credit usage after auth reads the org.
    // Retry from that newer snapshot instead of resetting its counters from stale data.
    if (!org || !planChangeIsDue(org, now)) return org;
    const pending = org.pendingPlanChange;
    const plan = getPlan(pending.plan);
    const effectiveAt = new Date(pending.effectiveAt);
    const bonusUsed = bonusUsedForCredits(org);
    const updated = await Organization.findOneAndUpdate(
      { _id: org._id, __v: org.__v, 'pendingPlanChange.reference': pending.reference },
      {
        $set: {
          plan: plan.id,
          billingCycle: pending.billingCycle,
          billingStatus: 'active',
          currentPeriodStart: effectiveAt,
          currentPeriodEnd: new Date(pending.periodEnd),
          'aiCredits.included': plan.includedGuavaCredits ?? plan.includedAiCredits,
          'aiCredits.bonusUsed': bonusUsed,
          'aiCredits.used': bonusUsed,
          'aiCredits.resetAt': nextMonthlyAnniversary(effectiveAt, now),
        },
        $unset: { pendingPlanChange: 1 },
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) {
      org = await Organization.findById(org._id).lean();
      continue;
    }
    if (updated.plan !== org.plan) {
      await warnOnOverCapacityPlan(org._id, org.plan, updated.plan).catch(() => null);
      invalidateFutureForecastsForOrg(org._id).catch((error) => {
        logger.error('forecast_invalidation_failed', logger.errorFields(error));
      });
    }
    return updated;
  }
  throw new Error('Could not apply scheduled plan change after concurrent billing updates');
};

const applyCreditPayment = async (paymentSession, transaction) => {
  const paymentMethod = cardDetailsFromTransaction(transaction, paymentSession.provider);
  const org = await Organization.findOneAndUpdate(
    {
      _id: paymentSession.orgId,
      fulfilledPaymentReferences: { $ne: paymentSession.reference },
    },
    {
      ...(paymentMethod ? { $set: { paymentMethod } } : {}),
      $inc: {
        'aiCredits.bonus': Math.max(0, Number(paymentSession.credits) || 0),
        __v: 1,
      },
      $addToSet: { fulfilledPaymentReferences: paymentSession.reference },
    },
    { new: true, runValidators: true }
  ).select('+fulfilledPaymentReferences');

  if (org) return { org, applied: true, planChanged: false };
  const existing = await Organization.findById(paymentSession.orgId).select('+fulfilledPaymentReferences');
  if (!existing) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }
  if (appliedReferences(existing).includes(paymentSession.reference)) {
    return { org: existing, applied: false, planChanged: false };
  }
  throw new Error('Could not apply Guava Credit payment');
};

const mockCard = (paymentMethod) => ({
  brand: typeof paymentMethod?.brand === 'string' && /^[a-z ]{2,24}$/i.test(paymentMethod.brand.trim())
    ? paymentMethod.brand.trim().toLowerCase()
    : 'visa',
  last4: typeof paymentMethod?.last4 === 'string' && /^\d{4}$/.test(paymentMethod.last4)
    ? paymentMethod.last4 : '4242',
  exp_month: '12',
  exp_year: '2030',
});

/** Mock purchases share real reference-keyed fulfilment; clients without a key get their own session. */
const fulfilMockPayment = async ({ org, userId, kind, plan, billingCycle, credits, amount, idempotencyKey, paymentMethod }) => {
  const key = idempotencyKey ? normalizePaymentIdempotencyKey(idempotencyKey) : null;
  const requestFingerprint = paymentRequestFingerprint({ kind, plan, billingCycle, credits, amount });
  const find = () => PaymentSession.findOne({ orgId: org._id, kind, idempotencyKey: key });

  let session = key ? await find() : null;
  if (!session) {
    const reference = generateReference(kind);
    try {
      session = await PaymentSession.create({
        orgId: org._id,
        userId,
        provider: 'mock',
        kind,
        idempotencyKey: key,
        requestFingerprint,
        initializationStatus: 'ready',
        reference,
        providerTransactionId: `mock-${reference}`,
        amount,
        currency: 'ZAR',
        ...(kind === 'plan' ? { plan, billingCycle } : { credits }),
        status: 'pending',
      });
    } catch (error) {
      // Two requests with the same key can race past the findOne above; the
      // unique index on (orgId, kind, idempotencyKey) is what actually decides
      // which one creates the session.
      if (error?.code === 11000 && key) session = await find();
      if (!session) throw error;
    }
  }

  if (session.provider !== 'mock' ||
    (session.requestFingerprint || paymentRequestFingerprint(session)) !== requestFingerprint) {
    throw paymentInitiationError(
      'Idempotency-Key was already used for a different payment request',
      'PAYMENT_IDEMPOTENCY_CONFLICT', 409, { reference: session.reference }
    );
  }

  const transaction = { authorization: mockCard(paymentMethod) };
  const result = kind === 'plan'
    ? await applyPlanPayment(session, transaction)
    : await applyCreditPayment(session, null);
  const shown = cardDetailsFromTransaction(transaction, 'mock');
  await PaymentSession.updateOne(
    { _id: session._id, status: { $ne: 'paid' } },
    { $set: {
      status: 'paid', paidAt: new Date(),
      ...(kind === 'plan' ? { card: { brand: shown.brand, last4: shown.last4 } } : {}),
    } }
  );
  return { ...result, session };
};

/** Compatibility for callers that predate mock plan sessions. */
const fulfilMockCreditPurchase = (args) => fulfilMockPayment({ ...args, kind: 'credits' });

/** Spent credits remain spent; withdraw only as much of the reversed pack as is still available. */
const revokeUnusedPackCredits = (paymentSession, session) => Organization.updateOne(
  { _id: paymentSession.orgId },
  [{
    $set: {
      'aiCredits.bonus': {
        $max: [
          { $ifNull: ['$aiCredits.bonusUsed', 0] },
          { $subtract: [{ $ifNull: ['$aiCredits.bonus', 0] }, Math.max(0, Number(paymentSession.credits) || 0)] },
        ],
      },
      __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
    },
  }],
  { session }
);

module.exports = {
  cardDetailsFromTransaction, applyDuePlanChange, applyPlanPayment, applyCreditPayment, fulfilMockPayment, fulfilMockCreditPurchase, revokeUnusedPackCredits,
};
