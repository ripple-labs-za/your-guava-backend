const fs = require('fs');
const path = require('path');

// BE-11-T04: the remaining large files became barrels. Size is guarded by sourceHygiene.test.js (BE-11-T07).
const SRC = path.resolve(__dirname, '../../src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const lineCount = (relative) => (read(relative).match(/\n/g) || []).length;

describe('remaining splits (BE-11-T04)', () => {
  it.each([
    'services/usage.service.js', 'services/billingPayments.service.js', 'services/forecast.service.js',
    'controllers/auth.controller.js', 'controllers/analytics.controller.js',
  ])('keeps %s a barrel: under 60 lines and no function of its own', (barrel) => {
    expect(lineCount(barrel)).toBeLessThan(60);
    expect(read(barrel)).not.toMatch(/=>|function\s/);
  });

  it('moves Ask Guava and its credit metering out of the forecasts controller', () => {
    // Pins the AI chat move for good. It does not forbid the usage barrel: BE-06-T05 later meters the
    // history backfill (a forecast feature) from this controller. Step 25's grep checks the stricter
    // "no billing code" state at the time of the split.
    expect(read('controllers/forecasts.controller.js'))
      .not.toMatch(/anthropic\.service|InsightChat|BusinessChatResponse|ask_guava/);
    const askGuava = require('../../src/controllers/askGuava.controller');
    // A superset check, so a later Ask Guava handler does not have to edit this test; the step 25
    // exports diff pins the exact list at the time of the split.
    expect(Object.keys(askGuava))
      .toEqual(expect.arrayContaining(['chatInsights', 'getInsights', 'refreshGeneratedInsights', 'streamChatInsights']));
  });

  it('serves each public function from the module that owns it', () => {
    const own = (file, name) => require(`../../src/${file}`)[name];
    expect(own('services/usage.service', 'meterGuavaCredits')).toBe(own('services/usage/meter', 'meterGuavaCredits'));
    expect(own('services/usage.service', 'billingAccessForOrganization')).toBe(own('services/usage/policy', 'billingAccessForOrganization'));
    expect(own('services/billingPayments.service', 'reconcileOneGatePayment')).toBe(own('services/billing/reconcile', 'reconcileOneGatePayment'));
    expect(own('services/forecast.service', 'generateForecast')).toBe(own('services/forecast/generate', 'generateForecast'));
    expect(own('services/forecast.service', '_test').weightedAverage).toBe(own('services/forecast/history', 'weightedAverage'));
    expect(own('controllers/auth.controller', 'login')).toBe(own('controllers/auth/sessions', 'login'));
    expect(own('controllers/analytics.controller', 'getRevenue')).toBe(own('controllers/analytics/revenue', 'getRevenue'));
  });
});
