// Billing access and the AI safety policy: trial and period inference, the daily AI credit caps.
// Moved from usage.service.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const UsageLedger = require('../../models/UsageLedger.model');
const { addBillingCycle } = require('../billingPlans.service');

const DEFAULT_TRIAL_DAYS = 14;
const DEFAULT_TRIAL_MS = DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000;

const AI_FEATURE_KEYS = new Set([
  'ask_guava_chat',
  'import_column_mapping',
  'menu_item_ai_review',
  'insight_refresh',
]);

const boundedPolicyInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
};

const aiUsagePolicy = () => ({
  userDailyCredits: boundedPolicyInteger(
    process.env.AI_USER_DAILY_CREDIT_LIMIT,
    500,
    10,
    100_000
  ),
  orgDailyCredits: boundedPolicyInteger(
    process.env.AI_ORG_DAILY_CREDIT_LIMIT,
    2_000,
    10,
    1_000_000
  ),
  userConcurrency: boundedPolicyInteger(
    process.env.AI_USER_CONCURRENCY_LIMIT,
    2,
    1,
    20
  ),
  orgConcurrency: boundedPolicyInteger(
    process.env.AI_ORG_CONCURRENCY_LIMIT,
    8,
    1,
    100
  ),
});

const asDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const inferredTrialEnd = (org) => {
  const explicit = asDate(org?.trialEndsAt);
  if (explicit) return explicit;
  const createdAt = asDate(org?.createdAt || org?.trialStartedAt);
  return createdAt ? new Date(createdAt.getTime() + DEFAULT_TRIAL_MS) : null;
};

const inferredCurrentPeriodEnd = (org) => {
  const explicit = asDate(org?.currentPeriodEnd);
  if (explicit) return explicit;
  const startedAt = asDate(org?.subscriptionStartedAt || org?.currentPeriodStart);
  return startedAt ? addBillingCycle(startedAt, org?.billingCycle) : null;
};

const billingGraceDays = () => boundedPolicyInteger(process.env.BILLING_GRACE_DAYS, 3, 0, 14);

// D-025: metered access stays closed; only reads get a short period after a real lapse.
const withGrace = (access, current) => {
  const closed = { ...access, readOnly: false, graceEndsAt: null };
  if (access.allowed || access.storedStatus === 'canceled') return closed;
  const periodEnd = asDate(access.periodEnd);
  const days = billingGraceDays();
  if (!periodEnd || periodEnd > current || days === 0) return closed;
  const graceEndsAt = new Date(periodEnd.getTime() + days * 24 * 60 * 60 * 1000);
  return graceEndsAt > current ? { ...access, status: 'grace', readOnly: true, graceEndsAt } : closed;
};

const billingAccessForOrganization = (org, now = new Date()) => {
  if (!org) {
    return { allowed: false, status: 'missing', reason: 'organization_missing', periodEnd: null, readOnly: false, graceEndsAt: null };
  }

  const current = asDate(now) || new Date();
  const status = org.billingStatus || 'past_due';
  if (status === 'trialing') {
    const periodEnd = inferredTrialEnd(org);
    const allowed = Boolean(periodEnd && periodEnd > current);
    return withGrace({
      allowed,
      status: allowed ? status : 'past_due',
      storedStatus: status,
      reason: allowed ? null : 'trial_expired',
      periodEnd,
      trialEndsAt: periodEnd,
    }, current);
  }

  if (status === 'active') {
    const periodEnd = inferredCurrentPeriodEnd(org);
    const allowed = Boolean(periodEnd && periodEnd > current);
    return withGrace({
      allowed,
      status: allowed ? status : 'past_due',
      storedStatus: status,
      reason: allowed ? null : 'billing_period_expired',
      periodEnd,
      currentPeriodEnd: periodEnd,
    }, current);
  }

  const paidPeriodEnd = inferredCurrentPeriodEnd(org);
  const trialEnd = inferredTrialEnd(org);
  const trialExpired = !paidPeriodEnd && trialEnd && trialEnd <= current;
  return withGrace({
    allowed: false,
    status,
    storedStatus: status,
    reason: status === 'canceled' ? 'subscription_canceled' : trialExpired ? 'trial_expired' : 'payment_required',
    periodEnd: paidPeriodEnd || trialEnd,
  }, current);
};

const billingRequiredError = (access) => {
  const err = new Error('An active trial or paid billing period is required');
  err.statusCode = 402;
  err.code = 'BILLING_REQUIRED';
  err.details = {
    code: err.code,
    billingStatus: access?.status || 'past_due',
    reason: access?.reason || 'payment_required',
    periodEnd: access?.periodEnd || null,
    readOnly: Boolean(access?.readOnly),
    graceEndsAt: access?.graceEndsAt || null,
  };
  return err;
};

const aiPolicyError = (code, message, details) => {
  const error = new Error(message);
  error.statusCode = 429;
  error.code = code;
  error.details = { code, ...details };
  return error;
};

// An $expr over a computed field cannot use an index, so this used to scan every
// ledger row the organisation had ever written -- inside the reservation
// transaction, on every paid AI request. The $or is the same 24-hour window as an
// indexable range plus a legacy branch for rows written before reservedAt existed.
const dailyAiCredits = (scope, since, session) => UsageLedger.aggregate([
  {
    $match: {
      ...scope,
      featureKey: { $in: [...AI_FEATURE_KEYS] },
      status: { $in: ['reserved', 'recovering', 'committed', 'refunded'] },
      $or: [
        { reservedAt: { $gte: since } },
        { reservedAt: null, createdAt: { $gte: since } },
      ],
    },
  },
  { $match: { $or: [{ status: { $ne: 'refunded' } }, { providerConsumedRuns: { $gt: 0 } }] } },
  {
    $group: {
      _id: null,
      credits: {
        $sum: {
          $add: [
            { $cond: [{ $in: ['$status', ['reserved', 'recovering', 'committed']] }, '$credits', 0] },
            { $multiply: ['$credits', { $ifNull: ['$providerConsumedRuns', 0] }] },
          ],
        },
      },
    },
  },
]).session(session);

const enforceAiUsagePolicy = async ({ orgId, userId, featureKey, credits }, session) => {
  if (!AI_FEATURE_KEYS.has(featureKey)) return;
  const limits = aiUsagePolicy();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeStatuses = ['reserved', 'recovering'];
  const policyOrgId = mongoose.Types.ObjectId.isValid(orgId)
    ? new mongoose.Types.ObjectId(orgId)
    : orgId;
  const policyUserId = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const [userDaily, orgDaily, userConcurrent, orgConcurrent] = await Promise.all([
    dailyAiCredits({ orgId: policyOrgId, userId: policyUserId }, since, session),
    dailyAiCredits({ orgId: policyOrgId }, since, session),
    UsageLedger.countDocuments({
      orgId: policyOrgId,
      userId: policyUserId,
      featureKey: { $in: [...AI_FEATURE_KEYS] },
      status: { $in: activeStatuses },
    }).session(session),
    UsageLedger.countDocuments({
      orgId: policyOrgId,
      featureKey: { $in: [...AI_FEATURE_KEYS] },
      status: { $in: activeStatuses },
    }).session(session),
  ]);

  const userUsed = Number(userDaily[0]?.credits) || 0;
  const orgUsed = Number(orgDaily[0]?.credits) || 0;
  if (userUsed + credits > limits.userDailyCredits) {
    throw aiPolicyError(
      'AI_USER_DAILY_BUDGET_REACHED',
      'Your daily AI credit safety limit has been reached',
      { limit: limits.userDailyCredits, used: userUsed, required: credits }
    );
  }
  if (orgUsed + credits > limits.orgDailyCredits) {
    throw aiPolicyError(
      'AI_ORG_DAILY_BUDGET_REACHED',
      'The organization daily AI credit safety limit has been reached',
      { limit: limits.orgDailyCredits, used: orgUsed, required: credits }
    );
  }
  if (userConcurrent >= limits.userConcurrency) {
    throw aiPolicyError(
      'AI_USER_CONCURRENCY_LIMIT',
      'You already have the maximum number of AI requests in progress',
      { limit: limits.userConcurrency }
    );
  }
  if (orgConcurrent >= limits.orgConcurrency) {
    throw aiPolicyError(
      'AI_ORG_CONCURRENCY_LIMIT',
      'The organization already has the maximum number of AI requests in progress',
      { limit: limits.orgConcurrency }
    );
  }
};

module.exports = {
  AI_FEATURE_KEYS, aiUsagePolicy, asDate, billingAccessForOrganization, billingGraceDays, billingRequiredError, aiPolicyError,
  enforceAiUsagePolicy,
};
