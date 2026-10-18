const {
  DEFAULT_FORECAST_SETTINGS,
  getFactorEntitlements,
  getForecastSettings,
  normalizeForecastSettings,
  buildGlobalFactors,
  buildItemFactors,
  multiplyFactors,
  eventImpactPct,
} = require('../../src/services/forecastFactors.service');
const { _test: forecastMath } = require('../../src/services/forecast.service');

describe('forecast factors', () => {
  const baseSignals = {
    loadSheddingStage: 0,
    isPublicHoliday: false,
    isSchoolHoliday: false,
    isPayday: false,
  };

  it('preserves the default recent-week history weights', () => {
    const settings = normalizeForecastSettings();

    expect(settings.history.recentWeights).toEqual([0.35, 0.25, 0.20]);
    expect(settings.history.twoWeekWeights).toEqual([0.6, 0.4]);
  });

  it('keeps default weather behaviour for hot, cold, and rainy days', () => {
    const settings = normalizeForecastSettings();

    const hotColdDrink = buildItemFactors({
      category: 'cold_drink',
      signals: baseSignals,
      weather: { temp: 30, condition: 'Sunny', isRain: false },
      events: [],
      settings,
    });
    expect(hotColdDrink.find((f) => f.key === 'weather').multiplier).toBeCloseTo(1.30, 2);

    const hotCoffee = buildItemFactors({
      category: 'coffee',
      signals: baseSignals,
      weather: { temp: 30, condition: 'Sunny', isRain: false },
      events: [],
      settings,
    });
    expect(hotCoffee.find((f) => f.key === 'weather').multiplier).toBeCloseTo(0.90, 2);

    const coldRain = buildItemFactors({
      category: 'cold_drink',
      signals: baseSignals,
      weather: { temp: 12, condition: 'Rain', isRain: true },
      events: [],
      settings,
    });
    expect(coldRain.find((f) => f.key === 'weather').multiplier).toBeCloseTo(0.70, 2);
  });

  it('keeps weather factors neutral when weather is explicitly unavailable', () => {
    const settings = normalizeForecastSettings({ payday: { pct: 10 } });
    const weather = {
      available: false,
      temp: 35,
      condition: 'Rain',
      isRain: true,
      unavailableReason: 'Cafe coordinates are not configured',
    };

    const itemFactors = buildItemFactors({
      category: 'cold_drink',
      signals: { ...baseSignals, isPayday: true },
      weather,
      events: [],
      settings,
    });
    const itemWeather = itemFactors.find((factor) => factor.key === 'weather');
    expect(itemWeather).toEqual(expect.objectContaining({
      active: false,
      adjustmentPct: 0,
      multiplier: 1,
      reason: 'Cafe coordinates are not configured',
    }));
    expect(multiplyFactors(itemFactors)).toBeCloseTo(1.10, 2);

    const summaryWeather = buildGlobalFactors({
      signals: baseSignals,
      weather,
      events: [],
      settings,
    }).find((factor) => factor.key === 'weather');
    expect(summaryWeather).toEqual(expect.objectContaining({
      active: false,
      multiplier: 1,
      reason: 'Cafe coordinates are not configured',
    }));
  });

  it('keeps default load shedding, holiday, payday, and event weights', () => {
    const settings = normalizeForecastSettings();
    const factors = buildGlobalFactors({
      signals: {
        loadSheddingStage: 5,
        isPublicHoliday: true,
        isSchoolHoliday: true,
        isPayday: true,
      },
      weather: { temp: 22, condition: 'Clear', isRain: false },
      events: [{ name: 'Market', impact: 'high' }],
      settings,
    });

    expect(factors.find((f) => f.key === 'loadShedding').multiplier).toBeCloseTo(0.60, 2);
    expect(factors.find((f) => f.key === 'holiday').multiplier).toBeCloseTo(1.20, 2);
    expect(factors.find((f) => f.key === 'payday').multiplier).toBeCloseTo(1.20, 2);
    expect(factors.find((f) => f.key === 'events').multiplier).toBeCloseTo(1.35, 2);
  });

  it('keeps load-shedding factors neutral when the stage is unknown', () => {
    const settings = normalizeForecastSettings();
    const factors = buildItemFactors({
      category: 'coffee',
      signals: {
        ...baseSignals,
        loadSheddingStage: null,
        loadSheddingAvailable: false,
        loadSheddingUnavailableReason: 'Load-shedding data is temporarily unavailable',
      },
      weather: { available: true, temp: 22, condition: 'Clear', isRain: false },
      events: [],
      settings,
    });

    expect(factors.find((factor) => factor.key === 'loadShedding')).toEqual(
      expect.objectContaining({
        active: false,
        adjustmentPct: 0,
        multiplier: 1,
        reason: 'Load-shedding data is temporarily unavailable',
      })
    );
    expect(multiplyFactors(factors)).toBe(1);
  });

  it('gates effective factor settings by subscription plan', () => {
    const cafe = {
      forecastSettings: normalizeForecastSettings({
        events: { enabled: true, highPct: 50 },
        payday: { enabled: true, pct: 12 },
        stock: { safetyMarginPct: 25, maxBiasPct: 40 },
        history: { maxWeeks: 12 },
        learning: { enabled: true },
      }),
    };

    const starter = getForecastSettings(cafe, 'starter');
    expect(starter.events.enabled).toBe(false);
    expect(starter.payday.enabled).toBe(false);
    expect(starter.stock.safetyMarginPct).toBe(0);
    expect(starter.history.maxWeeks).toBe(DEFAULT_FORECAST_SETTINGS.history.maxWeeks);
    expect(starter.learning.enabled).toBe(false);

    const growth = getForecastSettings(cafe, 'growth');
    expect(growth.events.enabled).toBe(true);
    expect(growth.events.highPct).toBe(50);
    expect(growth.payday.pct).toBe(12);
    expect(growth.stock.safetyMarginPct).toBe(25);
    expect(growth.learning.enabled).toBe(false);

    const pro = getForecastSettings(cafe, 'pro');
    expect(pro.history.maxWeeks).toBe(12);
    expect(pro.learning.enabled).toBe(true);
  });

  it('returns factor entitlements for the current plan', () => {
    const entitlements = getFactorEntitlements('growth');

    expect(entitlements.unlockedKeys).toEqual(
      expect.arrayContaining(['weather', 'holiday', 'payday', 'events', 'loadShedding', 'stock'])
    );
    expect(entitlements.lockedKeys).toEqual(expect.arrayContaining(['history', 'learning']));
  });

  it('applies cafe-specific factor overrides', () => {
    const settings = normalizeForecastSettings({
      payday: { pct: 12 },
      events: { highPct: 50 },
    });

    const factors = buildGlobalFactors({
      signals: { ...baseSignals, isPayday: true },
      weather: { temp: 22, condition: 'Clear', isRain: false },
      events: [{ name: 'Derby Day', impact: 'high' }],
      settings,
    });

    expect(factors.find((f) => f.key === 'payday').multiplier).toBeCloseTo(1.12, 2);
    expect(factors.find((f) => f.key === 'events').multiplier).toBeCloseTo(1.50, 2);
  });

  it('lets a local event carry an explicit weighting', () => {
    const settings = normalizeForecastSettings();

    expect(eventImpactPct({ impact: 'high', impactPct: 62 }, settings.events)).toBe(62);
    expect(eventImpactPct({ impact: 'low' }, settings.events)).toBe(DEFAULT_FORECAST_SETTINGS.events.lowPct);
  });

  it('does not treat closure records as demand-uplift events', () => {
    const settings = normalizeForecastSettings();
    const factors = buildGlobalFactors({
      signals: baseSignals,
      weather: { temp: 22, condition: 'Clear', isRain: false },
      events: [{ name: 'Maintenance', type: 'closure', impact: 'high' }],
      settings,
    });

    expect(factors.find((factor) => factor.key === 'events')).toEqual(
      expect.objectContaining({ active: false, multiplier: 1 })
    );
  });

  it('multiplies the active item factors into a final demand modifier', () => {
    const settings = normalizeForecastSettings({ payday: { pct: 10 } });
    const factors = buildItemFactors({
      category: 'coffee',
      signals: { ...baseSignals, isPayday: true },
      weather: { temp: 12, condition: 'Clear', isRain: false },
      events: [],
      settings,
    });

    expect(multiplyFactors(factors)).toBeCloseTo(1.15 * 1.10, 2);
  });
});

describe('forecast history math', () => {
  const history = {
    maxWeeks: 3,
    recentWeights: [0.35, 0.25, 0.20],
    twoWeekWeights: [0.6, 0.4],
  };

  it('normalizes a three-week window instead of dropping twenty percent of demand', () => {
    const weights = forecastMath.buildHistoryWeights(3, history);
    expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 8);
    expect(forecastMath.weightedAverage([10, 10, 10], history)).toBeCloseTo(10, 8);
  });

  it('keeps missing weeks missing while counting observed no-sale weeks as zero', () => {
    const target = new Date('2026-07-29T22:00:00.000Z');
    const transactions = [
      {
        date: new Date('2026-07-22T22:00:00.000Z'),
        items: [{ name: 'Flat White', quantity: 2 }],
      },
      {
        date: new Date('2026-07-15T22:00:00.000Z'),
        items: [{ name: 'Muffin', quantity: 3 }],
      },
    ];
    const { itemWeekMap, observedBuckets } = forecastMath.groupByWeekAndItem(
      transactions,
      target,
      'Africa/Johannesburg',
      3
    );

    expect([...observedBuckets]).toEqual([0, 1]);
    expect(itemWeekMap.get('Flat White')).toEqual([2, 0, null]);
    expect(itemWeekMap.get('Muffin')).toEqual([0, 3, null]);
    expect(forecastMath.weightedAverage([10, null, 30], history)).toBeCloseTo(17.2727, 3);
  });

  it('forces full closures to zero and scales partial closures by open minutes', () => {
    const cafe = {
      tradingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        isOpen: true,
        openTime: '08:00',
        closeTime: '16:00',
      })),
    };
    expect(forecastMath.getTradingAvailability(
      cafe,
      [{ name: 'Closed', type: 'closure' }],
      4
    )).toEqual(expect.objectContaining({ status: 'closed', multiplier: 0 }));
    expect(forecastMath.getTradingAvailability(
      cafe,
      [{
        name: 'Repairs',
        type: 'partial_closure',
        closureWindow: { startTime: '12:00', endTime: '16:00' },
      }],
      4
    )).toEqual(expect.objectContaining({ status: 'ready', multiplier: 0.5 }));

    expect(forecastMath.getTradingAvailability(
      cafe,
      [
        {
          name: 'Repairs phase one',
          type: 'partial_closure',
          closureWindow: { startTime: '10:00', endTime: '13:00' },
        },
        {
          name: 'Repairs phase two',
          type: 'partial_closure',
          closureWindow: { startTime: '12:00', endTime: '14:00' },
        },
      ],
      4
    )).toEqual(expect.objectContaining({ status: 'ready', multiplier: 0.5 }));
  });
});

describe('weighted average rounding boundary', () => {
  const { weightedAverage } = require('../../src/services/forecast.service')._test;
  const history = {
    maxWeeks: 8,
    recentWeights: [0.35, 0.25, 0.2],
    twoWeekWeights: [0.6, 0.4],
  };

  it('lands exactly on .5 rather than a hair below it', () => {
    // 0.35 + 0.25 + 0.20 is 0.7999... in binary floating point, so the
    // normalised weights accumulate error. Before this was settled, these
    // buckets produced 22.499999999999986: displayed as 22.5 but rounded to 22,
    // so the base quantity and the prediction visibly disagreed.
    const value = weightedAverage([10, 20, 30, 40, 40, 40, 40, 40], history);
    expect(value).toBe(22.5);
    expect(Math.round(value)).toBe(23);
  });

  it('still returns 0 when no week has been observed', () => {
    expect(weightedAverage([null, null, null, null, null, null, null, null], history)).toBe(0);
  });

  it('ignores missing weeks instead of treating them as zero sales', () => {
    // Two observed weeks of 10 must average 10, not be dragged down by the six
    // weeks where the cafe recorded no trading at all.
    expect(weightedAverage([10, 10, null, null, null, null, null, null], history)).toBe(10);
  });
});

describe('forecast confidence', () => {
  const { forecastConfidence } = require('../../src/services/forecast.service')._test;

  it('reports high only when volume and evidence both support it', () => {
    expect(forecastConfidence(8, 8)).toBe('high');
  });

  it('caps a high-volume item at medium on two weeks of evidence', () => {
    expect(forecastConfidence(8, 2)).toBe('medium');
  });

  it('caps a high-volume item at low on a single observed week', () => {
    // The failure this guards: a cafe that uploaded a fortnight ago saw "high"
    // against an item backed by one matching trading day.
    expect(forecastConfidence(8, 1)).toBe('low');
  });

  it('never raises confidence above what the volume justifies', () => {
    expect(forecastConfidence(1, 8)).toBe('low');
    expect(forecastConfidence(3, 8)).toBe('medium');
  });

  it('treats an unknown evidence count as sufficient rather than punishing it', () => {
    expect(forecastConfidence(8)).toBe('high');
  });

  it('returns low for a non-numeric quantity', () => {
    expect(forecastConfidence(undefined, 8)).toBe('low');
    expect(forecastConfidence(NaN, 8)).toBe('low');
  });
});

describe('history lookback vs the minimum required weeks', () => {
  const { requiredHistoryWeeks } = require('../../src/services/forecast.service')._test;

  it('requires the usual three weeks on a default lookback', () => {
    expect(requiredHistoryWeeks(8)).toBe(3);
    expect(requiredHistoryWeeks(16)).toBe(3);
    expect(requiredHistoryWeeks(3)).toBe(3);
  });

  it('never demands more weeks than the lookback can supply', () => {
    // The Factors page lets a lookback be set as low as one week. Demanding
    // three observed weeks from a two-week window is unsatisfiable, so every
    // forecast stayed insufficient_data for ever, blaming the data rather than
    // the setting.
    expect(requiredHistoryWeeks(2)).toBe(2);
    expect(requiredHistoryWeeks(1)).toBe(1);
  });

  it('falls back to the default for a missing or nonsensical lookback', () => {
    expect(requiredHistoryWeeks(undefined)).toBe(3);
    expect(requiredHistoryWeeks(0)).toBe(3);
    expect(requiredHistoryWeeks(-4)).toBe(3);
  });
});

describe('suggested stock bias', () => {
  const { computeSuggestedStockFromPairs } = require('../../src/services/forecast.service')._test;
  const settings = { stock: { safetyMarginPct: 10, maxBiasPct: 50 } };

  it('counts days the item sold nothing when measuring bias', () => {
    // Predicted 10; sold 15 on three days and none on three, so the true mean
    // is 7.5. Dropping the zero days left only the three overshoots, giving the
    // maximum +50% bias and a suggestion of 17. Counting them, the clamped
    // -50% observations cancel the overshoots exactly, leaving the safety
    // margin alone: 11.
    const pairs = [
      { predicted: 10, actual: 15 }, { predicted: 10, actual: 15 }, { predicted: 10, actual: 15 },
      { predicted: 10, actual: 0 }, { predicted: 10, actual: 0 }, { predicted: 10, actual: 0 },
    ];
    expect(computeSuggestedStockFromPairs(10, pairs, settings)).toBe(11);

    const withoutZeroDays = pairs.filter((p) => p.actual > 0);
    expect(computeSuggestedStockFromPairs(10, withoutZeroDays, settings)).toBe(17);
  });

  it('still buffers upward for an item that genuinely outsells its forecast', () => {
    const pairs = [
      { predicted: 10, actual: 14 }, { predicted: 10, actual: 13 }, { predicted: 10, actual: 15 },
    ];
    expect(computeSuggestedStockFromPairs(10, pairs, settings)).toBeGreaterThan(10);
  });

  it('never suggests less than the forecast itself', () => {
    const pairs = [
      { predicted: 10, actual: 0 }, { predicted: 10, actual: 0 }, { predicted: 10, actual: 1 },
    ];
    expect(computeSuggestedStockFromPairs(10, pairs, settings)).toBe(10);
  });

  it('applies only the safety margin before there is enough evidence', () => {
    expect(computeSuggestedStockFromPairs(10, [{ predicted: 10, actual: 12 }], settings)).toBe(11);
  });
});

describe('history window', () => {
  const Cafe = require('../../src/models/Cafe.model');
  const Organization = require('../../src/models/Organization.model');
  const Transaction = require('../../src/models/Transaction.model');
  const Event = require('../../src/models/Event.model');
  const Item = require('../../src/models/Item.model');
  const Forecast = require('../../src/models/Forecast.model');
  const { generateForecast } = require('../../src/services/forecast.service');
  const { addZonedDays, zonedDayStart } = require('../../src/services/parser.service');

  const timezone = 'Africa/Johannesburg';
  const target = new Date('2030-03-06T12:00:00+02:00');
  const lean = (value) => {
    const chain = {
      select: () => chain, sort: () => chain, limit: () => chain, session: () => chain,
      lean: () => Promise.resolve(value),
      then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
    return chain;
  };

  // Drives generateForecast against stubbed models and captures the
  // transaction query it issues. Learning is off so no calibration reads run,
  // and there are no coordinates so no weather call is made.
  const runWith = async ({ plan, maxWeeks }) => {
    jest.restoreAllMocks();
    const cafe = {
      _id: 'cafe-1',
      orgId: 'org-1',
      timezone,
      forecastSettings: { history: { maxWeeks }, learning: { enabled: false } },
    };
    jest.spyOn(Cafe, 'findById').mockReturnValue(lean(cafe));
    jest.spyOn(Organization, 'findById').mockReturnValue(lean({ plan }));
    const find = jest.spyOn(Transaction, 'find').mockReturnValue(lean([]));
    jest.spyOn(Event, 'find').mockReturnValue(lean([]));
    jest.spyOn(Item, 'find').mockReturnValue(lean([]));
    jest.spyOn(Forecast, 'findOne').mockReturnValue({ select: () => lean(null) });
    jest.spyOn(Forecast, 'find').mockReturnValue(lean([]));
    jest.spyOn(Transaction, 'findOne').mockReturnValue(lean(null));
    jest.spyOn(Forecast, 'findOneAndUpdate').mockImplementation(async (_filter, update) => update.$set);

    const forecast = await generateForecast('cafe-1', target);
    return { query: find.mock.calls[0][0], forecast };
  };

  const weeksBefore = (weeks) => addZonedDays(zonedDayStart(target, timezone), -weeks * 7, timezone);

  afterEach(() => jest.restoreAllMocks());

  it('queries exactly as many weeks of history as the lookback asks for', async () => {
    // The window was a fixed 56 days while the lookback was settable to 16, so
    // buckets 8-15 could never be populated and a longer lookback was inert.
    const twelve = await runWith({ plan: 'pro', maxWeeks: 12 });
    expect(twelve.query.date.$gte).toEqual(weeksBefore(12));
    expect(twelve.forecast.factorSettings.history.maxWeeks).toBe(12);

    const four = await runWith({ plan: 'pro', maxWeeks: 4 });
    expect(four.query.date.$gte).toEqual(weeksBefore(4));
    expect(four.query.date.$lt).toEqual(zonedDayStart(target, timezone));
  });

  it('sizes the window from the plan-clamped lookback, not the stored one', async () => {
    const starter = await runWith({ plan: 'starter', maxWeeks: 12 });
    expect(starter.query.date.$gte).toEqual(weeksBefore(8));
    expect(starter.forecast.factorSettings.history.maxWeeks).toBe(8);
  });
});

describe('closed-day explanation', () => {
  const { getTradingAvailability, describeClosedDay } = require('../../src/services/forecast.service')._test;
  const openAllWeek = {
    tradingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      openTime: '08:00',
      closeTime: '16:00',
    })),
  };
  const closedThursday = {
    tradingHours: openAllWeek.tradingHours.map((day) =>
      (day.dayOfWeek === 4 ? { ...day, isOpen: false } : day)
    ),
  };
  const stocktake = [{ name: 'Stocktake', type: 'closure' }];

  it('attributes a closure to the schedule or to an event', () => {
    expect(getTradingAvailability(closedThursday, [], 4)).toEqual(
      expect.objectContaining({ status: 'closed', source: 'schedule' })
    );
    expect(getTradingAvailability(openAllWeek, stocktake, 4)).toEqual(
      expect.objectContaining({ status: 'closed', source: 'event', eventName: 'Stocktake' })
    );
  });

  it('points a schedule closure with sales history at the trading hours', () => {
    const trading = getTradingAvailability(closedThursday, [], 4);
    const result = describeClosedDay(trading, { salesCount: 919, observedWeeks: 8, maxWeeks: 8 });

    expect(result.contradictsHistory).toBe(true);
    expect(result.reason).toContain('919 sales were recorded on this weekday in the last 8 weeks');
    expect(result.reason).toContain('Check the trading hours in Settings');
  });

  it('points an event closure at the event, never at the trading hours', () => {
    // A closure event on a normal trading day used to read "Stocktake, but 919
    // sales were recorded ... Check the trading hours in Settings", sending the
    // operator to the wrong screen. The event is deliberate, so it is not a
    // contradiction either.
    const trading = getTradingAvailability(openAllWeek, stocktake, 4);
    const result = describeClosedDay(trading, { salesCount: 919, observedWeeks: 8, maxWeeks: 8 });

    expect(result.contradictsHistory).toBe(false);
    expect(result.reason).toBe('Closed for Stocktake. Remove the event in Factors if the cafe is trading.');
    expect(result.reason).not.toMatch(/trading hours/i);
  });

  it('keeps a schedule closure with no history as a plain closure', () => {
    const trading = getTradingAvailability(closedThursday, [], 4);
    expect(describeClosedDay(trading, { salesCount: 0, observedWeeks: 0, maxWeeks: 8 })).toEqual({
      contradictsHistory: false,
      reason: 'Cafe is closed in its trading hours',
    });
  });
});
