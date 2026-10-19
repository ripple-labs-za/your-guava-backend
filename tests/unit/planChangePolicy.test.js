const {
  planChangeForPayment,
  effectivePaidThrough,
} = require('../../src/services/billingPayments.service');
const { PLAN_CONFIG, addBillingCycle, planRank } = require('../../src/services/billingPlans.service');

const DAY = 24 * 60 * 60 * 1000;
const at = (iso) => new Date(iso);
const activeOrg = (fields) => ({ billingStatus: 'active', ...fields });

describe('D-019 plan change policy (planChangeForPayment)', () => {
  it('starts a new term now when there is no live paid period', () => {
    const now = at('2026-03-20T00:00:00.000Z');
    const change = planChangeForPayment(
      { billingStatus: 'trialing', plan: 'starter' },
      { plan: 'growth', billingCycle: 'monthly' },
      now
    );
    expect(change).toEqual({
      type: 'new',
      plan: 'growth',
      billingCycle: 'monthly',
      effectiveAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: at('2026-04-20T00:00:00.000Z'),
      creditDays: 0,
    });
  });

  it('treats an active org whose period has already ended as new', () => {
    const org = activeOrg({
      plan: 'growth',
      billingCycle: 'monthly',
      currentPeriodStart: at('2026-02-10T00:00:00.000Z'),
      currentPeriodEnd: at('2026-03-10T00:00:00.000Z'),
    });
    const change = planChangeForPayment(org, { plan: 'starter', billingCycle: 'monthly' }, at('2026-03-20T00:00:00.000Z'));
    expect(change.type).toBe('new');
    expect(change.currentPeriodEnd).toEqual(at('2026-04-20T00:00:00.000Z'));
  });

  it('extends a same-plan, same-cycle renewal by one cycle from the current end', () => {
    const org = activeOrg({
      plan: 'growth',
      billingCycle: 'monthly',
      currentPeriodStart: at('2026-03-10T00:00:00.000Z'),
      currentPeriodEnd: at('2026-04-10T00:00:00.000Z'),
    });
    const change = planChangeForPayment(org, { plan: 'growth', billingCycle: 'monthly' }, at('2026-03-20T00:00:00.000Z'));
    expect(change.type).toBe('renewal');
    expect(change.currentPeriodStart).toEqual(at('2026-03-10T00:00:00.000Z'));
    expect(change.currentPeriodEnd).toEqual(at('2026-05-10T00:00:00.000Z'));
  });

  it('starts a new term when the paid period ends at exactly now', () => {
    const now = at('2026-03-20T00:00:00.000Z');
    const change = planChangeForPayment(activeOrg({
      plan: 'pro', billingCycle: 'annual', currentPeriodEnd: now,
    }), { plan: 'starter', billingCycle: 'monthly' }, now);

    expect(change).toEqual({
      type: 'new', plan: 'starter', billingCycle: 'monthly', creditDays: 0,
      effectiveAt: now, currentPeriodStart: now, currentPeriodEnd: at('2026-04-20T00:00:00.000Z'),
    });
  });

  it('preserves the paid end when renewing a legacy record with no start date', () => {
    const now = at('2026-03-20T00:00:00.000Z');
    const change = planChangeForPayment(activeOrg({
      plan: 'growth', billingCycle: 'monthly', currentPeriodEnd: at('2026-04-10T00:00:00.000Z'),
    }), { plan: 'growth', billingCycle: 'monthly' }, now);

    expect(change.type).toBe('renewal');
    expect(change.currentPeriodStart).toEqual(now);
    expect(change.currentPeriodEnd).toEqual(at('2026-05-10T00:00:00.000Z'));
  });

  it('normalizes unknown cycle strings to monthly without losing the live paid term', () => {
    const now = at('2026-03-20T00:00:00.000Z');
    const end = at('2026-04-10T00:00:00.000Z');
    const change = planChangeForPayment(activeOrg({
      plan: 'growth', billingCycle: 'legacy-cycle', currentPeriodEnd: end,
    }), { plan: 'growth', billingCycle: 'unknown-cycle' }, now);

    expect(change).toEqual({
      type: 'renewal', plan: 'growth', billingCycle: 'monthly', creditDays: 0,
      effectiveAt: now, currentPeriodStart: now, currentPeriodEnd: at('2026-05-10T00:00:00.000Z'),
    });
  });

  it('upgrades now and credits the unused Starter annual term as Growth days (billing-3 b)', () => {
    const org = activeOrg({
      plan: 'starter',
      billingCycle: 'annual',
      currentPeriodStart: at('2026-01-01T00:00:00.000Z'),
      currentPeriodEnd: at('2027-01-01T00:00:00.000Z'),
    });
    const now = at('2026-01-02T00:00:00.000Z');
    const change = planChangeForPayment(org, { plan: 'growth', billingCycle: 'annual' }, now);
    // 364 unused days x R3,990/365 = R3,979.07, bought back at R8,990/365 a day = 161.5 days.
    expect(change).toEqual(expect.objectContaining({
      type: 'upgrade', plan: 'growth', billingCycle: 'annual', effectiveAt: now, currentPeriodStart: now, creditDays: 161,
    }));
    expect(change.currentPeriodEnd).toEqual(at('2027-06-12T00:00:00.000Z'));
  });

  it('upgrades across cycles without discarding the annual term (billing-3 a)', () => {
    const org = activeOrg({
      plan: 'growth',
      billingCycle: 'annual',
      currentPeriodStart: at('2026-01-01T00:00:00.000Z'),
      currentPeriodEnd: at('2027-01-01T00:00:00.000Z'),
    });
    const now = at('2026-03-01T00:00:00.000Z');
    const change = planChangeForPayment(org, { plan: 'pro', billingCycle: 'monthly' }, now);
    // 306 unused days x R8,990/365 = R7,536.82, at R1,799/30 a day = 125.7 days.
    expect(change).toEqual(expect.objectContaining({ type: 'upgrade', plan: 'pro', billingCycle: 'monthly', creditDays: 125 }));
    expect(change.currentPeriodEnd).toEqual(at('2026-08-04T00:00:00.000Z'));
  });

  it('schedules a downgrade for the end of the paid period (billing-3 c)', () => {
    const org = activeOrg({
      plan: 'pro',
      billingCycle: 'monthly',
      currentPeriodStart: at('2026-03-10T00:00:00.000Z'),
      currentPeriodEnd: at('2026-04-10T00:00:00.000Z'),
    });
    const change = planChangeForPayment(org, { plan: 'starter', billingCycle: 'monthly' }, at('2026-03-20T00:00:00.000Z'));
    expect(change).toEqual({
      type: 'downgrade',
      plan: 'starter',
      billingCycle: 'monthly',
      effectiveAt: at('2026-04-10T00:00:00.000Z'),
      currentPeriodStart: at('2026-04-10T00:00:00.000Z'),
      currentPeriodEnd: at('2026-05-10T00:00:00.000Z'),
      creditDays: 0,
    });
  });

  it('schedules an annual-to-monthly switch for the end of the annual term', () => {
    const org = activeOrg({
      plan: 'growth',
      billingCycle: 'annual',
      currentPeriodStart: at('2026-01-01T00:00:00.000Z'),
      currentPeriodEnd: at('2027-01-01T00:00:00.000Z'),
    });
    const change = planChangeForPayment(org, { plan: 'growth', billingCycle: 'monthly' }, at('2026-03-01T00:00:00.000Z'));
    expect(change).toEqual(expect.objectContaining({
      type: 'cycle_switch', effectiveAt: at('2027-01-01T00:00:00.000Z'), currentPeriodEnd: at('2027-02-01T00:00:00.000Z'),
    }));
  });

  it('schedules a monthly-to-annual switch for the end of the paid month', () => {
    const org = activeOrg({
      plan: 'growth',
      billingCycle: 'monthly',
      currentPeriodStart: at('2026-03-10T00:00:00.000Z'),
      currentPeriodEnd: at('2026-04-10T00:00:00.000Z'),
    });
    const change = planChangeForPayment(org, { plan: 'growth', billingCycle: 'annual' }, at('2026-03-20T00:00:00.000Z'));
    expect(change).toEqual(expect.objectContaining({
      type: 'cycle_switch', effectiveAt: at('2026-04-10T00:00:00.000Z'), currentPeriodEnd: at('2027-04-10T00:00:00.000Z'),
    }));
  });

  it('ranks a legacy free plan as Starter and reports the later paid-through date', () => {
    expect(planRank('free')).toBe(planRank('starter'));
    const org = activeOrg({
      plan: 'free',
      billingCycle: 'monthly',
      currentPeriodStart: at('2026-03-10T00:00:00.000Z'),
      currentPeriodEnd: at('2026-04-10T00:00:00.000Z'),
    });
    expect(planChangeForPayment(org, { plan: 'starter', billingCycle: 'monthly' }, at('2026-03-20T00:00:00.000Z')).type)
      .toBe('renewal');
    expect(effectivePaidThrough({
      ...org,
      pendingPlanChange: { periodEnd: at('2026-05-10T00:00:00.000Z') },
    })).toEqual(at('2026-05-10T00:00:00.000Z'));
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'ranks the unknown plan id %s as Starter instead of inheriting an object property', (unknown) => {
      expect(planRank(unknown)).toBe(1);
      const now = at('2026-03-20T00:00:00.000Z');
      const change = planChangeForPayment(activeOrg({
        plan: unknown, billingCycle: 'monthly', currentPeriodEnd: at('2026-04-10T00:00:00.000Z'),
      }), { plan: 'growth', billingCycle: 'monthly' }, now);

      expect(change.type).toBe('upgrade');
      expect(Number.isFinite(change.creditDays)).toBe(true);
      expect(change.currentPeriodEnd.getTime()).toBeGreaterThan(at('2026-04-20T00:00:00.000Z').getTime());
    }
  );

  describe('no paid term is ever discarded', () => {
    const plans = Object.keys(PLAN_CONFIG);
    const cycles = ['monthly', 'annual'];
    const combos = plans.flatMap((from) => cycles.flatMap((fromCycle) =>
      plans.flatMap((to) => cycles.map((toCycle) => [from, fromCycle, to, toCycle]))));
    const price = (plan, cycle) => (cycle === 'annual' ? PLAN_CONFIG[plan].priceAnnual : PLAN_CONFIG[plan].priceMonthly);
    const perDay = (plan, cycle) => price(plan, cycle) / (cycle === 'annual' ? 365 : 30);

    it.each(combos)('%s %s -> %s %s keeps every paid day, or its value', (from, fromCycle, to, toCycle) => {
      const start = at('2026-01-15T00:00:00.000Z');
      const end = addBillingCycle(start, fromCycle);
      const now = new Date(start.getTime() + (end.getTime() - start.getTime()) / 3);
      const org = activeOrg({ plan: from, billingCycle: fromCycle, currentPeriodStart: start, currentPeriodEnd: end });
      const change = planChangeForPayment(org, { plan: to, billingCycle: toCycle }, now);
      const unusedValue = ((end.getTime() - now.getTime()) / DAY) * perDay(from, fromCycle);

      if (change.type === 'renewal') { // static-checks: allow conditional-expect it.each over every plan pair: each change type has its own rule
        expect(change.currentPeriodEnd).toEqual(addBillingCycle(end, toCycle));
      } else if (change.type === 'upgrade') { // static-checks: allow conditional-expect same table, the upgrade rule
        expect(planRank(to)).toBeGreaterThan(planRank(from));
        const credited = change.creditDays * perDay(to, toCycle);
        expect(credited).toBeLessThanOrEqual(unusedValue + 1e-6);
        expect(unusedValue - credited).toBeLessThan(perDay(to, toCycle));
      } else { // static-checks: allow conditional-expect same table, the downgrade and cycle-switch rule
        expect(['downgrade', 'cycle_switch']).toContain(change.type);
        expect(change.effectiveAt).toEqual(end);
        expect(change.currentPeriodEnd).toEqual(addBillingCycle(end, toCycle));
      }
    });
  });
});
