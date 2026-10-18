// Plan-period maths for a payment, and the forecast invalidation a plan change triggers.
// Moved from billingPayments.service.js by BE-11-T04; behaviour unchanged.
const Cafe = require('../../models/Cafe.model');
const { invalidatePlanningForecasts } = require('../forecast/generate');
const { getPlan, getPlans, addBillingCycle, planRank } = require('../billingPlans.service');

const invalidateFutureForecastsForOrg = async (orgId) => {
  const cafes = await Cafe.find({ orgId }).select('_id timezone').lean();
  if (cafes.length === 0) return;

  for (const cafe of cafes) await invalidatePlanningForecasts(cafe._id, { timezone: cafe.timezone });
};

const DAY_MS = 24 * 60 * 60 * 1000;
// D-019: list prices are converted per day on a 30-day month and a 365-day year.
const CYCLE_DAYS = { monthly: 30, annual: 365 };
const SCHEDULED_CHANGE_TYPES = new Set(['downgrade', 'cycle_switch']);

const normaliseCycle = (cycle) => (cycle === 'annual' ? 'annual' : 'monthly');
const listPrice = (planId, cycle) => {
  const plan = getPlan(planId);
  return cycle === 'annual' ? plan.priceAnnual : plan.priceMonthly;
};
const hasLivePaidPeriod = (org, now) => {
  const end = org?.currentPeriodEnd ? new Date(org.currentPeriodEnd) : null;
  return org?.billingStatus === 'active' && Boolean(end) && end > now;
};
// BE-07-T04 replaces this with the anchor rule; until then a renewal chains from the current end.
const renewalPeriodEnd = (_anchor, existingEnd, cycle) => addBillingCycle(existingEnd, cycle);

/**
 * What a plan payment buys, decided from the organisation as it is at `now` (D-019).
 * Upgrades start now and convert the unused part of the current term into extra days at list prices;
 * downgrades and cycle switches start when the current term ends, so no paid day is lost.
 */
const planChangeForPayment = (org, { plan, billingCycle }, now = new Date()) => {
  const cycle = normaliseCycle(billingCycle);
  const target = getPlan(plan).id;
  const base = { plan: target, billingCycle: cycle, creditDays: 0 };

  if (!hasLivePaidPeriod(org, now)) {
    return {
      type: 'new', ...base, effectiveAt: new Date(now), currentPeriodStart: new Date(now),
      currentPeriodEnd: addBillingCycle(now, cycle),
    };
  }

  const current = getPlan(org.plan).id;
  const currentCycle = normaliseCycle(org.billingCycle);
  const existingEnd = new Date(org.currentPeriodEnd);

  if (target === current && cycle === currentCycle) {
    const anchor = org.currentPeriodStart ? new Date(org.currentPeriodStart) : null;
    return {
      type: 'renewal', ...base, effectiveAt: new Date(now), currentPeriodStart: anchor || new Date(now),
      currentPeriodEnd: renewalPeriodEnd(anchor, existingEnd, cycle),
    };
  }

  if (planRank(target) > planRank(current)) {
    const remainingDays = (existingEnd.getTime() - now.getTime()) / DAY_MS;
    const unusedValue = remainingDays * listPrice(current, currentCycle) * CYCLE_DAYS[cycle];
    const creditDays = Math.max(0, Math.floor(unusedValue / (CYCLE_DAYS[currentCycle] * listPrice(target, cycle))));
    return {
      type: 'upgrade', ...base, creditDays, effectiveAt: new Date(now), currentPeriodStart: new Date(now),
      currentPeriodEnd: new Date(addBillingCycle(now, cycle).getTime() + creditDays * DAY_MS),
    };
  }

  return {
    type: target === current ? 'cycle_switch' : 'downgrade', ...base,
    effectiveAt: existingEnd, currentPeriodStart: existingEnd, currentPeriodEnd: addBillingCycle(existingEnd, cycle),
  };
};

const isScheduledChange = (change) => SCHEDULED_CHANGE_TYPES.has(change?.type);

const serialisePlanChange = (change) => ({
  plan: change.plan,
  billingCycle: change.billingCycle,
  type: change.type,
  effectiveAt: new Date(change.effectiveAt).toISOString(),
  periodEnd: new Date(change.currentPeriodEnd).toISOString(),
  creditDays: change.creditDays,
});

const previewPlanChanges = (org, now = new Date()) => {
  const blocked = org?.pendingPlanChange?.effectiveAt ? 'PLAN_CHANGE_ALREADY_SCHEDULED' : null;
  return getPlans().flatMap((plan) => ['monthly', 'annual'].map((billingCycle) => ({
    ...serialisePlanChange(planChangeForPayment(org, { plan: plan.id, billingCycle }, now)),
    blocked,
  })));
};

const effectivePaidThrough = (org) => {
  const end = org?.currentPeriodEnd ? new Date(org.currentPeriodEnd) : null;
  const pending = org?.pendingPlanChange?.periodEnd ? new Date(org.pendingPlanChange.periodEnd) : null;
  if (pending && (!end || pending > end)) return pending;
  return end;
};

const planChangeIsDue = (org, now = new Date()) =>
  Boolean(org?.pendingPlanChange?.effectiveAt) && new Date(org.pendingPlanChange.effectiveAt) <= now;

const formatBillingDate = (value) => new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: DEFAULT_TIMEZONE,
}).format(new Date(value));

module.exports = { invalidateFutureForecastsForOrg, planChangeForPayment, isScheduledChange, serialisePlanChange, previewPlanChanges, effectivePaidThrough, planChangeIsDue, formatBillingDate, renewalPeriodEnd };
