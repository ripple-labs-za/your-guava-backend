const { getFactorEntitlements, factorUnlocked } = require('../../src/services/forecastFactors.service');
const { normalisePlanId } = require('../../src/services/billingPlans.service');

describe('one plan catalogue (gap-7)', () => {
  it('ranks a legacy free plan as Starter in forecast factors, as billing does', () => {
    const entitlements = getFactorEntitlements('free');
    expect(entitlements.plan).toBe('starter');
    expect(entitlements.unlockedKeys).toEqual(expect.arrayContaining(['weather', 'holiday']));
    expect(factorUnlocked('free', 'weather')).toBe(true);
  });

  it('agrees with billing for every stored or unknown plan id', () => {
    for (const plan of ['free', 'starter', 'growth', 'pro', undefined, 'bogus', '__proto__', 'constructor', 'toString']) {
      expect(getFactorEntitlements(plan).plan).toBe(normalisePlanId(plan));
    }
  });
});
