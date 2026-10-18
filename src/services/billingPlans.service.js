const PLAN_CONFIG = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 399,
    priceAnnual: 3990,
    includedSeats: 2,
    includedAiCredits: 150,
    includedGuavaCredits: 400,
    includedLocations: 2,
    overagePerSeat: 120,
    aiCreditPackPrice: 99,
    guavaCreditPackPrice: 99,
    creditPackOptions: [
      { credits: 500, price: 99 },
      { credits: 1500, price: 249 },
      { credits: 5000, price: 699 },
    ],
    features: [
      'CSV imports and 7-day forecasts',
      'Weather and holiday forecast factors',
      '400 Guava Credits for AI and data checks',
      '2 cafe locations',
      'Basic analytics',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceMonthly: 899,
    priceAnnual: 8990,
    includedSeats: 6,
    includedAiCredits: 600,
    includedGuavaCredits: 1800,
    includedLocations: 3,
    overagePerSeat: 100,
    aiCreditPackPrice: 89,
    guavaCreditPackPrice: 89,
    creditPackOptions: [
      { credits: 500, price: 89 },
      { credits: 1500, price: 229 },
      { credits: 5000, price: 649 },
    ],
    features: [
      'Multi-location forecasting',
      'Events, payday, load shedding, and stock buffer factors',
      'Team roles and location access',
      'Advanced analytics',
      '1,800 Guava Credits for AI and data checks',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 1799,
    priceAnnual: 17990,
    includedSeats: 15,
    includedAiCredits: 2000,
    includedGuavaCredits: 6000,
    includedLocations: 10,
    overagePerSeat: 80,
    aiCreditPackPrice: 69,
    guavaCreditPackPrice: 69,
    creditPackOptions: [
      { credits: 500, price: 69 },
      { credits: 1500, price: 199 },
      { credits: 5000, price: 599 },
    ],
    features: [
      '10 locations included',
      'Learning correction and advanced history weighting',
      '6,000 Guava Credits for AI and data checks',
      'Forecast audit trails',
      'Priority support',
    ],
  },
};

const normalisePlanId = (plan) => (PLAN_CONFIG[plan] ? plan : 'starter');

const getPlan = (plan) => PLAN_CONFIG[normalisePlanId(plan)];

const getPlans = () => Object.values(PLAN_CONFIG);

const startOfNextUtcMonth = (from = new Date()) => {
  const value = new Date(from);
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
};

const addUtcMonthsClamped = (from, months) => {
  const value = new Date(from);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
  value.setUTCDate(Math.min(day, lastDay));
  return value;
};

const addBillingCycle = (from, billingCycle = 'monthly') =>
  addUtcMonthsClamped(from, billingCycle === 'annual' ? 12 : 1);

/**
 * The first monthly anniversary of `anchor` strictly after `from`.
 *
 * Credit allowances belong to the subscription, so their boundary has to be the
 * subscription's own anniversary rather than the calendar rollover. Each
 * candidate is measured from the anchor and not from the previous anniversary,
 * because a clamped month-end (31 January -> 28 February) would otherwise drag
 * every later boundary forward to the 28th and quietly shorten the window.
 */
const nextMonthlyAnniversary = (anchor, from = new Date()) => {
  const start = new Date(anchor);
  const reference = new Date(from);
  if (Number.isNaN(start.getTime())) return startOfNextUtcMonth(reference);
  if (Number.isNaN(reference.getTime())) return start;

  let months = Math.max(
    0,
    (reference.getUTCFullYear() - start.getUTCFullYear()) * 12
      + (reference.getUTCMonth() - start.getUTCMonth())
  );
  let candidate = addUtcMonthsClamped(start, months);
  // At most two extra steps: the month arithmetic above lands on the same
  // calendar month, so only the day-of-month and the clamp can still be short.
  while (candidate <= reference) {
    months += 1;
    candidate = addUtcMonthsClamped(start, months);
  }
  return candidate;
};

/** One ranking for every reader (billing, forecast factors). Unknown ids, including the legacy 'free', rank as Starter. */
const PLAN_RANK = { starter: 1, growth: 2, pro: 3 };
const planRank = (plan) => PLAN_RANK[normalisePlanId(plan)];

module.exports = {
  PLAN_RANK, planRank,
  PLAN_CONFIG,
  addBillingCycle,
  addUtcMonthsClamped,
  getPlan,
  getPlans,
  normalisePlanId,
  nextMonthlyAnniversary,
  startOfNextUtcMonth,
};
