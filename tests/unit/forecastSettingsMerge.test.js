const { normalizeForecastSettings } = require('../../src/services/forecastFactors.service');

describe('forecast settings merge (ISSUES #14)', () => {
  it('ignores __proto__, constructor and prototype keys in an override', () => {
    const input = JSON.parse('{"__proto__":{"payday":{"pct":90}},"payday":{"pct":12,"__proto__":{"enabled":false}},"constructor":{"x":1}}');
    const settings = normalizeForecastSettings(input);
    expect(settings.payday).toEqual({ enabled: true, pct: 12 });
    expect(Object.getPrototypeOf(settings.payday)).toBe(Object.prototype);
    expect({}.pct).toBeUndefined();
  });
});
