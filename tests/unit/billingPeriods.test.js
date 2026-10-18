const { planChangeForPayment, renewalPeriodEnd } = require('../../src/services/billingPayments.service');
const { nextMonthlyAnniversary } = require('../../src/services/billingPlans.service');

const at = (iso) => new Date(iso);
const monthlyOrg = (anchor, end) => ({
  billingStatus: 'active', plan: 'growth', billingCycle: 'monthly', currentPeriodStart: at(anchor), currentPeriodEnd: at(end),
});

describe('renewals keep the subscription anniversary (billing-11)', () => {
  it.each([null, '2027-04-30T06:00:00.000Z', '2027-05-31T06:00:00.000Z', 'invalid'])('extends safely with an absent, equal, later or invalid anchor %s', (anchor) => {
    expect(renewalPeriodEnd(anchor, at('2027-04-30T06:00:00.000Z'), 'monthly'))
      .toEqual(at('2027-05-30T06:00:00.000Z'));
  });

  it('renews a 31 January subscriber to 31 March, not 28 March', () => {
    const change = planChangeForPayment(
      monthlyOrg('2026-01-31T06:00:00.000Z', '2026-02-28T06:00:00.000Z'),
      { plan: 'growth', billingCycle: 'monthly' },
      at('2026-02-20T00:00:00.000Z')
    );
    expect(change.type).toBe('renewal');
    expect(change.currentPeriodEnd).toEqual(at('2026-03-31T06:00:00.000Z'));
  });

  it('keeps every later renewal on the anchor day', () => {
    const anchor = at('2026-01-31T06:00:00.000Z');
    expect(renewalPeriodEnd(anchor, at('2026-03-31T06:00:00.000Z'), 'monthly')).toEqual(at('2026-04-30T06:00:00.000Z'));
    expect(renewalPeriodEnd(anchor, at('2026-04-30T06:00:00.000Z'), 'monthly')).toEqual(at('2026-05-31T06:00:00.000Z'));
  });

  it('returns a leap-day annual subscriber to the 29th when the calendar has one', () => {
    const anchor = at('2028-02-29T08:00:00.000Z');
    expect(renewalPeriodEnd(anchor, at('2029-02-28T08:00:00.000Z'), 'annual')).toEqual(at('2030-02-28T08:00:00.000Z'));
    expect(renewalPeriodEnd(anchor, at('2031-02-28T08:00:00.000Z'), 'annual')).toEqual(at('2032-02-29T08:00:00.000Z'));
  });

  it('extends an end that is off the anchor cadence (an upgrade credit) from the end itself', () => {
    expect(renewalPeriodEnd(at('2026-03-01T00:00:00.000Z'), at('2026-08-04T00:00:00.000Z'), 'monthly'))
      .toEqual(at('2026-09-04T00:00:00.000Z'));
  });

  it('lands the renewed end on the same instant as the credit window', () => {
    const anchor = at('2026-01-31T06:00:00.000Z');
    const oldEnd = at('2026-02-28T06:00:00.000Z');
    expect(renewalPeriodEnd(anchor, oldEnd, 'monthly')).toEqual(nextMonthlyAnniversary(anchor, oldEnd));
  });
});
