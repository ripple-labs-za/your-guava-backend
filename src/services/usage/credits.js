// Credit arithmetic: the credit window, snapshots, the JS and Mongo credit formulas, atomic reservation and refund.
// Moved from usage.service.js by BE-11-T04; behaviour unchanged.
const Organization = require('../../models/Organization.model');
const { addUtcMonthsClamped, nextMonthlyAnniversary, getPlan } = require('../billingPlans.service');
const { asDate, billingAccessForOrganization, billingRequiredError } = require('./policy');

/**
 * The instant the paid credit window is anchored on: the start of the billing
 * period, which is the only value that says when this organisation's month
 * begins.
 */
const creditWindowAnchor = (org, access, now) => {
  const explicitStart = asDate(org?.currentPeriodStart) || asDate(org?.subscriptionStartedAt);
  if (explicitStart) return explicitStart;

  // A legacy document may carry only a period end. Stepping it back by the
  // billing cycle recovers the start, so an annual subscriber keeps refreshing
  // monthly instead of waiting a year for the end date itself to come round.
  const periodEnd = asDate(access?.periodEnd);
  if (periodEnd) {
    return addUtcMonthsClamped(periodEnd, org?.billingCycle === 'annual' ? -12 : -1);
  }
  return asDate(org?.aiCredits?.resetAt) || now;
};

const creditResetDateForOrganization = (
  org,
  access = billingAccessForOrganization(org),
  now = new Date()
) => {
  // A trial is a single window: one allowance for the whole trial.
  if (access.status === 'trialing' && access.periodEnd) return new Date(access.periodEnd);

  // A paid allowance renews on the subscription's own monthly anniversary.
  // Taking the earlier of the calendar rollover and the period end used to hand
  // every organisation whose renewal day was not the 1st two full allowances a
  // month -- one at the rollover and a second at its own renewal -- so the
  // period end now caps access only and never grants credits.
  return nextMonthlyAnniversary(creditWindowAnchor(org, access, now), now);
};

const nonNegativeNumber = (value) => Math.max(0, Number(value) || 0);

const hasStoredBonusUsed = (org) => {
  if (org?.aiCredits?.bonusUsed == null) return false;
  return !(typeof org.$isDefault === 'function' && org.$isDefault('aiCredits.bonusUsed'));
};

// Legacy organizations only stored one combined `used` counter. Included credits
// have always been consumed first, so any usage above the included allowance is
// the only purchased-credit usage that can be inferred safely during migration.
const bonusUsedForCredits = (org) => {
  const plan = getPlan(org?.plan);
  const included = nonNegativeNumber(
    org?.aiCredits?.included ?? plan.includedGuavaCredits ?? plan.includedAiCredits
  );
  const bonus = nonNegativeNumber(org?.aiCredits?.bonus);
  const used = nonNegativeNumber(org?.aiCredits?.used);
  const stored = hasStoredBonusUsed(org)
    ? nonNegativeNumber(org.aiCredits.bonusUsed)
    : Math.max(0, used - included);
  return Math.min(bonus, stored);
};

const creditComponents = (org) => {
  const plan = getPlan(org?.plan);
  const included = nonNegativeNumber(
    org?.aiCredits?.included ?? plan.includedGuavaCredits ?? plan.includedAiCredits
  );
  const bonus = nonNegativeNumber(org?.aiCredits?.bonus);
  const bonusUsed = bonusUsedForCredits(org);
  const used = Math.max(nonNegativeNumber(org?.aiCredits?.used), bonusUsed);
  const includedUsed = Math.min(included, Math.max(0, used - bonusUsed));
  return {
    included,
    bonus,
    used,
    bonusUsed,
    includedUsed,
    includedAvailable: Math.max(0, included - includedUsed),
    bonusAvailable: Math.max(0, bonus - bonusUsed),
  };
};

const creditSnapshot = (org, now = new Date()) => {
  const { included, bonus, used, bonusUsed } = creditComponents(org);
  const access = billingAccessForOrganization(org, now);
  return {
    included,
    bonus,
    bonusUsed,
    used,
    available: access.allowed ? Math.max(0, included + bonus - used) : 0,
    resetAt: org.aiCredits?.resetAt || null,
  };
};

const refreshCreditWindow = async (orgId, now = new Date(), attempts = 0) => {
  const org = await Organization.findById(orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  const access = billingAccessForOrganization(org, now);
  if (!access.allowed) return org;

  const plan = getPlan(org.plan);
  const planIncluded = plan.includedGuavaCredits ?? plan.includedAiCredits;
  const resetAt = asDate(org.aiCredits?.resetAt);
  const stale = !resetAt || resetAt <= now;
  const bonusUsed = bonusUsedForCredits(org);
  const set = {};

  if (!org.trialEndsAt && access.trialEndsAt) set.trialEndsAt = access.trialEndsAt;
  if (!org.currentPeriodEnd && access.currentPeriodEnd) set.currentPeriodEnd = access.currentPeriodEnd;
  if (stale) {
    set['aiCredits.included'] = planIncluded;
    set['aiCredits.bonusUsed'] = bonusUsed;
    set['aiCredits.used'] = bonusUsed;
    set['aiCredits.resetAt'] = creditResetDateForOrganization(org, access, now);
  } else {
    if (org.aiCredits?.included !== planIncluded) set['aiCredits.included'] = planIncluded;
    if (!hasStoredBonusUsed(org) || org.aiCredits.bonusUsed !== bonusUsed) {
      set['aiCredits.bonusUsed'] = bonusUsed;
    }
    if (nonNegativeNumber(org.aiCredits?.used) < bonusUsed) set['aiCredits.used'] = bonusUsed;
  }

  if (Object.keys(set).length === 0) return org;
  const updated = await Organization.findOneAndUpdate(
    { _id: org._id, __v: org.__v },
    { $set: set, $inc: { __v: 1 } },
    { new: true, runValidators: true }
  );
  if (updated) return updated;
  if (attempts >= 2) return Organization.findById(orgId);
  return refreshCreditWindow(orgId, now, attempts + 1);
};

const normalizeCreditAmount = (amount) => Math.max(0, Math.ceil(Number(amount) || 0));

const insufficientCreditsError = (credits, amount) => {
  const err = new Error('Guava credit limit reached for this billing period');
  err.statusCode = 402;
  // Its own code: a bare 402 read as BILLING_REQUIRED, and a lapsed owner was told to buy credits (BE-13-T02).
  err.code = 'INSUFFICIENT_CREDITS';
  err.details = { code: 'INSUFFICIENT_CREDITS', ...credits, required: amount };
  return err;
};

const mongoIncludedCredits = () => ({ $max: [0, { $ifNull: ['$aiCredits.included', 0] }] });
const mongoBonusCredits = () => ({ $max: [0, { $ifNull: ['$aiCredits.bonus', 0] }] });
const mongoRawUsedCredits = () => ({ $max: [0, { $ifNull: ['$aiCredits.used', 0] }] });
const mongoBonusUsedCredits = () => ({
  $min: [
    mongoBonusCredits(),
    {
      $max: [
        0,
        {
          $ifNull: [
            '$aiCredits.bonusUsed',
            { $subtract: [mongoRawUsedCredits(), mongoIncludedCredits()] },
          ],
        },
      ],
    },
  ],
});
const mongoEffectiveUsedCredits = () => ({
  $max: [mongoRawUsedCredits(), mongoBonusUsedCredits()],
});
const mongoIncludedAvailableCredits = () => ({
  $max: [
    0,
    {
      $subtract: [
        mongoIncludedCredits(),
        {
          $max: [
            0,
            { $subtract: [mongoEffectiveUsedCredits(), mongoBonusUsedCredits()] },
          ],
        },
      ],
    },
  ],
});

const reserveCreditsAtomic = async (orgId, requested, now, session) => {
  const before = await Organization.findOneAndUpdate(
    {
      _id: orgId,
      $or: [
        { billingStatus: 'trialing', trialEndsAt: { $gt: now } },
        { billingStatus: 'active', currentPeriodEnd: { $gt: now } },
      ],
      $expr: {
        $gte: [
          {
            $subtract: [
              {
                $add: [
                  mongoIncludedCredits(),
                  mongoBonusCredits(),
                ],
              },
              mongoEffectiveUsedCredits(),
            ],
          },
          requested,
        ],
      },
    },
    [
      {
        $set: {
          'aiCredits.used': { $add: [mongoEffectiveUsedCredits(), requested] },
          'aiCredits.bonusUsed': {
            $add: [
              mongoBonusUsedCredits(),
              {
                $subtract: [
                  requested,
                  { $min: [requested, mongoIncludedAvailableCredits()] },
                ],
              },
            ],
          },
          __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
        },
      },
    ],
    { new: false, ...(session ? { session } : {}) }
  );

  if (!before) return null;
  const state = creditComponents(before);
  const included = Math.min(requested, state.includedAvailable);
  const allocation = { included, bonus: requested - included };
  let currentQuery = Organization.findById(orgId);
  if (session) currentQuery = currentQuery.session(session);
  const org = await currentQuery;
  return { org, allocation };
};

const throwCreditReservationError = async (orgId, requested, now) => {
  const latest = await Organization.findById(orgId);
  if (!latest) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }
  const latestAccess = billingAccessForOrganization(latest, now);
  if (!latestAccess.allowed) throw billingRequiredError(latestAccess);
  throw insufficientCreditsError(creditSnapshot(latest, now), requested);
};

const normalizeCreditAllocation = (allocation, fallbackCredits = 0) => {
  const total = normalizeCreditAmount(fallbackCredits);
  const included = Math.min(total, normalizeCreditAmount(allocation?.included));
  const bonus = Math.min(total - included, normalizeCreditAmount(allocation?.bonus));
  if (allocation && included + bonus === total) return { included, bonus };
  return { included: total, bonus: 0 };
};

const creditRefundPipeline = ({ allocation, expectedResetAt, conditionalIncluded = false }) => {
  const includedRefund = conditionalIncluded && expectedResetAt
    ? {
        $cond: [
          { $eq: ['$aiCredits.resetAt', expectedResetAt] },
          allocation.included,
          0,
        ],
      }
    : allocation.included;
  const totalRefund = { $add: [includedRefund, allocation.bonus] };
  const nextUsed = {
    $max: [0, { $subtract: [mongoEffectiveUsedCredits(), totalRefund] }],
  };
  const nextBonusUsed = {
    $min: [
      nextUsed,
      {
        $max: [
          0,
          { $subtract: [mongoBonusUsedCredits(), allocation.bonus] },
        ],
      },
    ],
  };

  return [
    {
      $set: {
        'aiCredits.used': nextUsed,
        'aiCredits.bonusUsed': nextBonusUsed,
        __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
      },
    },
  ];
};

module.exports = {
  bonusUsedForCredits, creditComponents, creditSnapshot, refreshCreditWindow, normalizeCreditAmount,
  reserveCreditsAtomic, throwCreditReservationError, normalizeCreditAllocation, creditRefundPipeline,
};
