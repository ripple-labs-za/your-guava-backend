const logger = require('../../utils/logger');
// The usage ledger: metered reservations, finish, commit after a lease breach, refund, recovery, the sweeper and the summary.
// Moved from usage.service.js by BE-11-T04; behaviour unchanged.
const crypto = require('crypto');
const mongoose = require('mongoose');
const Organization = require('../../models/Organization.model');
const UsageLedger = require('../../models/UsageLedger.model');
const { addUtcMonthsClamped } = require('../billingPlans.service');
const { billingAccessForOrganization, billingRequiredError, enforceAiUsagePolicy, asDate } = require('./policy');
const {
  normalizeCreditAmount, refreshCreditWindow, reserveCreditsAtomic, throwCreditReservationError, creditSnapshot, normalizeCreditAllocation,
  creditRefundPipeline,
} = require('./credits');

const DEFAULT_USAGE_RESERVATION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_RECONCILIATION_BATCH_SIZE = 50;

const cleanIdempotencyKey = (value) => {
  const key = String(value || '').trim();
  return key ? key.slice(0, 160) : undefined;
};

const usageRequestFingerprint = (payload) => {
  const relatedKind = String(payload.relatedEntity?.kind || '');
  const relatedId = String(payload.relatedEntity?.id || '');
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      orgId: String(payload.orgId || ''),
      cafeId: String(payload.cafeId || ''),
      userId: String(payload.userId || ''),
      featureKey: String(payload.featureKey || ''),
      credits: normalizeCreditAmount(payload.credits),
      semanticHash: String(payload.metadata?.semanticHash || '') || null,
      relatedEntity: relatedKind || relatedId
        ? { kind: relatedKind, id: relatedId }
        : null,
    }))
    .digest('hex');
};

const usageReplayError = (ledger) => {
  const err = new Error('This Guava Credit request has already been processed');
  err.statusCode = 409;
  err.details = {
    code: 'USAGE_IDEMPOTENCY_CONFLICT',
    status: ledger?.status || 'unknown',
  };
  return err;
};

const hasStoredResult = (ledger) =>
  ledger && ledger.get('resultPayload') !== undefined;

const createMeteredReservation = async ({ idempotencyKey, credits, ...payload }) => {
  const key = cleanIdempotencyKey(idempotencyKey);
  const requestFingerprint = usageRequestFingerprint({ credits, ...payload });
  const now = new Date();
  const current = await refreshCreditWindow(payload.orgId, now);
  const access = billingAccessForOrganization(current, now);
  if (!access.allowed) throw billingRequiredError(access);

  const session = await mongoose.startSession();
  let ledger;
  let reservedOrg;
  let creditAllocation;
  let replayed = false;
  let replayResult;
  try {
    await session.withTransaction(async () => {
      let existing = null;
      if (key) {
        existing = await UsageLedger.findOne({
          orgId: payload.orgId,
          idempotencyKey: key,
        }).session(session);
      }

      if (existing) {
        const existingFingerprint = existing.requestFingerprint || usageRequestFingerprint(existing);
        if (existingFingerprint !== requestFingerprint) {
          const conflict = usageReplayError(existing);
          conflict.details.code = 'USAGE_IDEMPOTENCY_FINGERPRINT_CONFLICT';
          throw conflict;
        }
        if (existing.status === 'committed' && hasStoredResult(existing)) {
          ledger = existing;
          replayed = true;
          replayResult = existing.resultPayload;
          reservedOrg = await Organization.findById(payload.orgId).session(session);
          return;
        }
        if (existing.status !== 'refunded') throw usageReplayError(existing);

        await enforceAiUsagePolicy(
          {
            orgId: payload.orgId,
            userId: payload.userId,
            featureKey: payload.featureKey,
            credits,
          },
          session
        );
        ledger = await UsageLedger.findOneAndUpdate(
          { _id: existing._id, status: 'refunded' },
          {
            $set: {
              ...payload,
              credits,
              status: 'reserved',
              requestFingerprint,
              reservedAt: now,
            },
            $unset: { completedAt: 1, recoveryReason: 1 },
            $inc: { replayCount: 1 },
          },
          { new: true, session, runValidators: true }
        );
        if (!ledger) throw usageReplayError(existing);
      } else {
        await enforceAiUsagePolicy(
          {
            orgId: payload.orgId,
            userId: payload.userId,
            featureKey: payload.featureKey,
            credits,
          },
          session
        );
        [ledger] = await UsageLedger.create(
          [{
            ...payload,
            credits,
            status: 'reserved',
            idempotencyKey: key,
            requestFingerprint,
            reservedAt: now,
          }],
          { session }
        );
      }

      if (replayed) return;

      const reservation = await reserveCreditsAtomic(payload.orgId, credits, now, session);
      if (!reservation) {
        const error = new Error('Guava Credit reservation rejected');
        error.code = 'CREDIT_RESERVATION_REJECTED';
        throw error;
      }
      reservedOrg = reservation.org;
      creditAllocation = reservation.allocation;

      const creditWindowResetAt = asDate(reservedOrg.aiCredits?.resetAt);
      const captured = await UsageLedger.updateOne(
        { _id: ledger._id, status: 'reserved' },
        { $set: { creditWindowResetAt, creditAllocation } },
        { session }
      );
      if (captured.matchedCount !== 1) {
        throw new Error('Could not capture the Guava Credit reservation window');
      }
      ledger.creditWindowResetAt = creditWindowResetAt;
      ledger.creditAllocation = creditAllocation;
    });
  } catch (error) {
    if (error.code === 11000 && key) {
      const existing = await UsageLedger.findOne({
        orgId: payload.orgId,
        idempotencyKey: key,
      }).lean();
      throw usageReplayError(existing);
    }
    if (error.code === 'CREDIT_RESERVATION_REJECTED') {
      await throwCreditReservationError(payload.orgId, credits, now);
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return {
    ledger,
    credits: creditSnapshot(reservedOrg, now),
    creditWindowResetAt: asDate(reservedOrg.aiCredits?.resetAt),
    creditAllocation,
    replayed,
    replayResult,
  };
};

// A refunded row can be reserved again with the same key. Every settlement must
// belong to the captured attempt, including callbacks arriving after a sweep.
// Older rows predate replayCount; treat their absent counter as attempt zero.
const usageAttemptFilter = (ledger) => ({
  _id: ledger._id,
  ...(ledger.replayCount
    ? { replayCount: ledger.replayCount }
    : { $or: [{ replayCount: 0 }, { replayCount: { $exists: false } }] }),
});

const finishUsage = (ledger, status, { resultPayload, providerDiagnostics, recoveryReason } = {}) =>
  UsageLedger.findOneAndUpdate(
    { ...usageAttemptFilter(ledger), status: 'reserved' },
    {
      $set: {
        status,
        completedAt: new Date(),
        ...(resultPayload !== undefined ? { resultPayload } : {}),
        ...(providerDiagnostics !== undefined ? { providerDiagnostics } : {}),
        ...(recoveryReason ? { recoveryReason } : {}),
      },
    },
    { new: true }
  );

/**
 * Commits a reservation the stale-reservation reconciler already refunded.
 *
 * A run that outlives its lease still cost real provider money, and on the SSE
 * path its answer is already on the customer's screen, so discarding it is the
 * worst available outcome -- the reserved-only commit filter used to throw the
 * answer away and leave the idempotency key pointing at a refunded row, making
 * the client's retry pay for the whole generation again. The row is claimed
 * first and the credits taken back afterwards, so the charge can never be
 * applied to a row this worker does not own.
 */
const commitAfterLeaseBreach = async (ledger, orgId, { resultPayload, providerDiagnostics }) => {
  const claimed = await UsageLedger.findOneAndUpdate(
    { ...usageAttemptFilter(ledger), status: 'refunded', recoveryReason: 'stale_reservation' },
    {
      $set: {
        status: 'committed',
        completedAt: new Date(),
        recoveryReason: 'lease_breach_recommitted',
        ...(resultPayload !== undefined ? { resultPayload } : {}),
        ...(providerDiagnostics !== undefined ? { providerDiagnostics } : {}),
      },
    },
    { new: true }
  );
  if (!claimed) return null;

  logger.warn('usage_reservation_recommitted', { ledgerId: String(claimed._id), orgId: String(orgId) });
  const recharge = await reserveCreditsAtomic(orgId, claimed.credits, new Date());
  if (!recharge) {
    // The answer was delivered, so the row stays committed. Recording that the
    // credits could not be taken again keeps the ledger honest.
    return UsageLedger.findOneAndUpdate(
      { _id: claimed._id, status: 'committed' },
      { $set: { recoveryReason: 'lease_breach_uncharged' } },
      { new: true }
    );
  }
  return UsageLedger.findOneAndUpdate(
    { _id: claimed._id, status: 'committed' },
    {
      $set: {
        creditAllocation: recharge.allocation,
        creditWindowResetAt: asDate(recharge.org.aiCredits?.resetAt),
      },
    },
    { new: true }
  );
};

const refundAndFinishUsage = async ({
  ledger,
  orgId,
  credits,
  creditWindowResetAt,
  creditAllocation,
  providerDiagnostics,
}) => {
  const consumed = Number(providerDiagnostics?.inputTokens) > 0 || Number(providerDiagnostics?.outputTokens) > 0;
  // A reconciler may already have released this hold. Count its provider usage without refunding twice.
  if (consumed) {
    const recovered = await UsageLedger.updateOne(
      { ...usageAttemptFilter(ledger), status: 'refunded', recoveryReason: 'stale_reservation' },
      { $set: { providerDiagnostics, recoveryReason: 'operation_failed' }, $inc: { providerConsumedRuns: 1 } }
    );
    if (recovered.matchedCount === 1) return;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const expectedResetAt = asDate(creditWindowResetAt);
      const allocation = normalizeCreditAllocation(
        creditAllocation || ledger?.creditAllocation,
        credits
      );
      await Organization.findOneAndUpdate(
        { _id: orgId },
        creditRefundPipeline({
          allocation,
          expectedResetAt,
          conditionalIncluded: true,
        }),
        { new: true, session }
      );

      const consumed = Number(providerDiagnostics?.inputTokens) > 0 || Number(providerDiagnostics?.outputTokens) > 0;
      const finished = await UsageLedger.updateOne(
        { ...usageAttemptFilter(ledger), status: 'reserved' },
        {
          $set: {
            status: 'refunded',
            recoveryReason: 'operation_failed',
            completedAt: new Date(),
            ...(consumed ? { providerDiagnostics } : {}),
          },
          ...(consumed ? { $inc: { providerConsumedRuns: 1 } } : {}),
        },
        { session }
      );
      if (finished.matchedCount !== 1) {
        throw new Error('Could not finalize refunded Guava Credit usage');
      }
    });
  } finally {
    await session.endSession();
  }
};

const recoverStaleUsageReservation = async (ledgerId, staleBefore) => {
  const session = await mongoose.startSession();
  let recovered = false;
  try {
    await session.withTransaction(async () => {
      const ledger = await UsageLedger.findOneAndUpdate(
        {
          _id: ledgerId,
          status: 'reserved',
          $or: [
            { reservedAt: { $lte: staleBefore } },
            { reservedAt: { $exists: false }, createdAt: { $lte: staleBefore } },
          ],
        },
        { $set: { status: 'recovering' } },
        { new: true, session }
      );
      if (!ledger) return;

      const allocation = normalizeCreditAllocation(ledger.creditAllocation, ledger.credits);
      await Organization.findOneAndUpdate(
        { _id: ledger.orgId },
        creditRefundPipeline({
          allocation,
          expectedResetAt: asDate(ledger.creditWindowResetAt),
          conditionalIncluded: true,
        }),
        { new: true, session }
      );
      const finished = await UsageLedger.updateOne(
        { _id: ledger._id, status: 'recovering' },
        {
          $set: {
            status: 'refunded',
            recoveryReason: 'stale_reservation',
            completedAt: new Date(),
          },
        },
        { session }
      );
      if (finished.matchedCount !== 1) {
        throw new Error('Could not finalize stale Guava Credit reservation');
      }
      recovered = true;
    });
  } finally {
    await session.endSession();
  }
  return recovered;
};

const reconcileStaleUsageReservations = async ({
  now = new Date(),
  leaseMs = DEFAULT_USAGE_RESERVATION_LEASE_MS,
  limit = DEFAULT_USAGE_RECONCILIATION_BATCH_SIZE,
  concurrency = 4,
} = {}) => {
  const boundedLeaseMs = Math.max(60_000, Number(leaseMs) || DEFAULT_USAGE_RESERVATION_LEASE_MS);
  const boundedLimit = Math.max(
    1,
    Math.min(Number(limit) || DEFAULT_USAGE_RECONCILIATION_BATCH_SIZE, 200)
  );
  const boundedConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 10));
  const staleBefore = new Date(now.getTime() - boundedLeaseMs);
  const candidates = await UsageLedger.find({
    status: 'reserved',
    $or: [
      { reservedAt: { $lte: staleBefore } },
      { reservedAt: { $exists: false }, createdAt: { $lte: staleBefore } },
    ],
  })
    .sort({ reservedAt: 1, _id: 1 })
    .limit(boundedLimit)
    .select('_id')
    .lean();

  const summary = { scanned: candidates.length, refunded: 0, skipped: 0, errors: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      try {
        if (await recoverStaleUsageReservation(candidates[index]._id, staleBefore)) {
          summary.refunded += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        summary.errors += 1;
        logger.error('usage_reconcile_failed', { ledgerId: String(candidates[index]._id), ...logger.errorFields(error) });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(boundedConcurrency, candidates.length) }, () => worker())
  );
  return summary;
};

const usageSummary = async (orgId, { limit = 12 } = {}) => {
  // setMonth overflows on a long month -- 31 March minus one month lands on 3
  // March -- which silently dropped the first days of the window it claims to
  // cover. The clamped helper is the same arithmetic the billing periods use.
  const since = addUtcMonthsClamped(new Date(), -1);

  const [byFeature, recent] = await Promise.all([
    UsageLedger.aggregate([
      {
        $match: {
          orgId,
          status: 'committed',
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$featureKey',
          label: { $first: '$label' },
          credits: { $sum: '$credits' },
          count: { $sum: 1 },
        },
      },
      { $sort: { credits: -1 } },
    ]),
    // Only settled charges are activity. Reserved/refunded rows are credit
    // holds that were (or will be) released, and the portal renders whatever
    // is returned here as spend.
    UsageLedger.find({ orgId, status: 'committed' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  return {
    byFeature: byFeature.map((row) => ({
      featureKey: row._id,
      label: row.label,
      credits: row.credits,
      count: row.count,
    })),
    recent: recent.map((entry) => ({
      id: entry._id,
      featureKey: entry.featureKey,
      label: entry.label,
      credits: entry.credits,
      status: entry.status,
      provider: entry.provider,
      createdAt: entry.createdAt,
    })),
  };
};

module.exports = {
  createMeteredReservation, finishUsage, commitAfterLeaseBreach, refundAndFinishUsage, recoverStaleUsageReservation, reconcileStaleUsageReservations,
  usageSummary,
};
