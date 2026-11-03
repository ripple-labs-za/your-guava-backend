// Factor-effect proof (release 3): every demand factor is shown end to end. The same cafe, history and day are forecast
// twice through generateForecast, once without the factor and once with it, and each item's expected quantity must move by
// exactly the factor's multiplier, on the items the factor is meant to touch and no others.
jest.mock('../../src/utils/signals', () => {
  const actual = jest.requireActual('../../src/utils/signals');
  return { ...actual, getSignalsForDate: jest.fn() };
});
// The forecast's weather comes from whichever entry point the generator uses (coordinates, or the W-1 query by location),
// so both return the scenario's weather and storing the observed day is a no-op that keeps the two runs independent.
jest.mock('../../src/services/weather.service', () => {
  const actual = jest.requireActual('../../src/services/weather.service');
  return {
    ...actual,
    getWeatherForecast: jest.fn(),
    ...(actual.getWeatherForQuery ? { getWeatherForQuery: jest.fn() } : {}),
    ...(actual.saveWeatherDay ? { saveWeatherDay: jest.fn().mockResolvedValue(null) } : {}),
  };
});

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Event = require('../../src/models/Event.model');
const Forecast = require('../../src/models/Forecast.model');
const Item = require('../../src/models/Item.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const signals = require('../../src/utils/signals');
const weatherService = require('../../src/services/weather.service');
const forecastService = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart, zonedDateKey, zonedDayOfWeek } = require('../../src/utils/timezone');

const TZ = 'Africa/Johannesburg';
const ITEMS = [
  { name: 'Flat White', category: 'coffee' },
  { name: 'Iced Tea', category: 'cold_drink' },
  { name: 'Croissant', category: 'food' },
];
const OPEN_ALL_WEEK = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: true, openTime: '07:00', closeTime: '17:00' }));
const QUIET_SIGNALS = {
  isPayday: false, isPublicHoliday: false, isSchoolHoliday: false,
  loadSheddingStage: 0, loadSheddingAvailable: true, loadSheddingSource: 'esp_status', loadSheddingTransient: false,
};
const MILD = { available: true, temp: 20, maxTemp: 20, condition: 'Partly cloudy', isRain: false, precipMm: 0, chanceOfRain: 0 };

let cafe;
let target;
let token;

// A weekday 1-7 days out, never Sunday, so the cafe's own schedule is open on it.
const pickTarget = () => {
  const today = zonedDayStart(new Date(), TZ);
  for (let offset = 1; offset <= 7; offset += 1) {
    const day = addZonedDays(today, offset, TZ);
    const dow = zonedDayOfWeek(day, TZ);
    if (dow >= 1 && dow <= 5) return day;
  }
  throw new Error('no weekday found');
};

const seedHistory = async () => {
  await Item.insertMany(ITEMS.map((item) => ({ cafeId: cafe._id, name: item.name, category: item.category, avgPrice: 30 })));
  const dow = zonedDayOfWeek(target, TZ);
  const rows = [];
  for (let week = 1; week <= 8; week += 1) {
    const day = addZonedDays(target, -7 * week, TZ);
    // Equal units at 09:00 and 14:00, so a closure over the morning removes exactly half the day's sales.
    for (const hour of [9, 14]) {
      rows.push({
        cafeId: cafe._id, date: new Date(day.getTime() + hour * 3600 * 1000), hour, dayOfWeek: dow, status: 'approved',
        total: 300, items: ITEMS.map((item) => ({ name: item.name, quantity: 10, unitPrice: 30, menuItemStatus: 'matched' })),
      });
    }
  }
  await Transaction.insertMany(rows);
};

// One forecast of the target day under the given day signals and weather; returns expected quantity per item plus the doc.
const forecastWith = async ({ daySignals = {}, weather = MILD } = {}) => {
  await Forecast.deleteMany({ cafeId: cafe._id });
  signals.getSignalsForDate.mockResolvedValue({ ...QUIET_SIGNALS, dayOfWeek: zonedDayOfWeek(target, TZ), ...daySignals });
  weatherService.getWeatherForecast.mockResolvedValue(weather);
  if (weatherService.getWeatherForQuery) weatherService.getWeatherForQuery.mockResolvedValue(weather);
  const doc = await forecastService.generateForecast(cafe._id, target, { origin: 'live' });
  const stored = await Forecast.findById(doc._id).lean();
  const qty = Object.fromEntries((stored.items || []).map((item) => [item.itemName, item.expectedQty]));
  return { qty, stored };
};

// The proof: the with/without ratio on each item equals the expected multiplier for that item's category.
const expectEffect = (without, withFactor, multipliers) => {
  for (const item of ITEMS) {
    expect(without.qty[item.name]).toBeGreaterThan(0);
    const ratio = withFactor.qty[item.name] / without.qty[item.name];
    expect({ item: item.name, ratio: Number(ratio.toFixed(4)) })
      .toEqual({ item: item.name, ratio: multipliers[item.category] });
  }
};

beforeAll(setup);
afterAll(teardown);
beforeEach(async () => {
  const created = await createTestUser();
  const { user } = created;
  token = created.token;
  await Organization.findByIdAndUpdate(user.orgId, { plan: 'pro' });
  cafe = await Cafe.findOneAndUpdate({}, {
    $set: { tradingHours: OPEN_ALL_WEEK, 'location.lat': -33.92, 'location.lng': 18.42, 'location.city': 'Cape Town' },
  }, { new: true });
  target = pickTarget();
  await seedHistory();
});
afterEach(async () => {
  jest.clearAllMocks();
  await clearDB();
});

describe('factor-effect proof: each factor moves the forecast by exactly its multiplier on the right items', () => {
  it('hot weather: cold drinks +30%, coffee -10%, food unchanged', async () => {
    const without = await forecastWith();
    const hot = await forecastWith({ weather: { ...MILD, temp: 31, maxTemp: 31, condition: 'Sunny' } });
    expectEffect(without, hot, { cold_drink: 1.3, coffee: 0.9, food: 1 });
  });

  it('cold weather: coffee +15%, cold drinks -20%, food unchanged', async () => {
    const without = await forecastWith();
    const cold = await forecastWith({ weather: { ...MILD, temp: 12, maxTemp: 12, condition: 'Overcast' } });
    expectEffect(without, cold, { coffee: 1.15, cold_drink: 0.8, food: 1 });
  });

  it('rain: every item -10%', async () => {
    const without = await forecastWith();
    const rain = await forecastWith({ weather: { ...MILD, condition: 'Moderate rain', isRain: true, precipMm: 6, chanceOfRain: 90 } });
    expectEffect(without, rain, { coffee: 0.9, cold_drink: 0.9, food: 0.9 });
  });

  it('public holiday +15%, school holiday +8%, both together +20% (not +24%)', async () => {
    const without = await forecastWith();
    expectEffect(without, await forecastWith({ daySignals: { isPublicHoliday: true } }), { coffee: 1.15, cold_drink: 1.15, food: 1.15 });
    expectEffect(without, await forecastWith({ daySignals: { isSchoolHoliday: true } }), { coffee: 1.08, cold_drink: 1.08, food: 1.08 });
    expectEffect(without, await forecastWith({ daySignals: { isPublicHoliday: true, isSchoolHoliday: true } }),
      { coffee: 1.2, cold_drink: 1.2, food: 1.2 });
  });

  it('payday: every item +20%', async () => {
    const without = await forecastWith();
    expectEffect(without, await forecastWith({ daySignals: { isPayday: true } }), { coffee: 1.2, cold_drink: 1.2, food: 1.2 });
  });

  it('local events: low +10%, medium +20%, high +35%, a custom weight exactly, the strongest event only', async () => {
    const without = await forecastWith();
    const dateKey = zonedDateKey(target, TZ);
    for (const [impact, multiplier] of [['low', 1.1], ['medium', 1.2], ['high', 1.35]]) {
      await Event.deleteMany({ cafeId: cafe._id });
      await Event.create({ cafeId: cafe._id, name: `Market (${impact})`, date: target, dateKey, type: 'event', impact });
      expectEffect(without, await forecastWith(), { coffee: multiplier, cold_drink: multiplier, food: multiplier });
    }
    await Event.deleteMany({ cafeId: cafe._id });
    await Event.create({ cafeId: cafe._id, name: 'Rugby final', date: target, dateKey, type: 'event', impact: 'low', impactPct: 42 });
    await Event.create({ cafeId: cafe._id, name: 'Book club', date: target, dateKey, type: 'event', impact: 'low' });
    expectEffect(without, await forecastWith(), { coffee: 1.42, cold_drink: 1.42, food: 1.42 });
  });

  it('load shedding: stage 1-2 -8%, stage 3-4 -22%, stage 5+ -40%', async () => {
    const without = await forecastWith();
    for (const [stage, multiplier] of [[2, 0.92], [4, 0.78], [6, 0.6]]) {
      expectEffect(without, await forecastWith({ daySignals: { loadSheddingStage: stage } }),
        { coffee: multiplier, cold_drink: multiplier, food: multiplier });
    }
  });

  it('load shedding with no provider is not connected and changes nothing', async () => {
    const without = await forecastWith();
    const notConnected = await forecastWith({ daySignals: {
      loadSheddingStage: null, loadSheddingAvailable: false, loadSheddingSource: null,
      loadSheddingUnavailableReason: signals.LOAD_SHEDDING_NOT_SET_UP,
    } });
    expectEffect(without, notConnected, { coffee: 1, cold_drink: 1, food: 1 });
    const factor = notConnected.stored.factors.find((entry) => entry.key === 'loadShedding');
    expect(factor).toEqual(expect.objectContaining({ active: false, multiplier: 1 }));
    expect(factor.reason).toMatch(/not connected/i);
  });

  it('trading hours: a day the schedule closes forecasts zero for every item', async () => {
    const without = await forecastWith();
    const dow = zonedDayOfWeek(target, TZ);
    await Cafe.updateOne({ _id: cafe._id }, { $set: { tradingHours: OPEN_ALL_WEEK.map((day) =>
      (day.dayOfWeek === dow ? { ...day, isOpen: false } : day)) } });
    const closed = await forecastWith();
    expectEffect(without, closed, { coffee: 0, cold_drink: 0, food: 0 });
    expect(closed.stored.factors.find((entry) => entry.key === 'tradingHours')).toEqual(
      expect.objectContaining({ active: true, multiplier: 0 }));
  });

  it('closures: a full closure event zeroes the day; a morning partial closure removes exactly the morning sales', async () => {
    const without = await forecastWith();
    const dateKey = zonedDateKey(target, TZ);
    await Event.create({ cafeId: cafe._id, name: 'Staff training', date: target, dateKey, type: 'closure' });
    expectEffect(without, await forecastWith(), { coffee: 0, cold_drink: 0, food: 0 });
    await Event.deleteMany({ cafeId: cafe._id });
    await Event.create({
      cafeId: cafe._id, name: 'Plumber', date: target, dateKey, type: 'partial_closure',
      closureWindow: { startTime: '08:00', endTime: '11:00' },
    });
    const partial = await forecastWith();
    expectEffect(without, partial, { coffee: 0.5, cold_drink: 0.5, food: 0.5 });
    expect(partial.stored.factors.find((entry) => entry.key === 'tradingHours').reason).toMatch(/hourly sales/);
  });

  it('factors stack multiplicatively: hot payday on a public holiday', async () => {
    const without = await forecastWith();
    const stacked = await forecastWith({
      daySignals: { isPayday: true, isPublicHoliday: true },
      weather: { ...MILD, temp: 31, maxTemp: 31, condition: 'Sunny' },
    });
    // coffee 0.9 x 1.2 x 1.15; cold drinks 1.3 x 1.2 x 1.15 = 1.794 is above the 1.6 bound; food 1.2 x 1.15.
    expectEffect(without, stacked, { coffee: 1.242, cold_drink: 1.6, food: 1.38 });
  });

  it('the combined factor multiplier is bounded to 0.5-1.6 and the bound is shown in the item breakdown', async () => {
    const without = await forecastWith();
    const dateKey = zonedDateKey(target, TZ);
    await Event.create({ cafeId: cafe._id, name: 'Festival', date: target, dateKey, type: 'event', impact: 'high' });
    const high = await forecastWith({ daySignals: { isPayday: true, isPublicHoliday: true, isSchoolHoliday: true } });
    // 1.2 x 1.2 x 1.35 = 1.944 raw, held at 1.6.
    expectEffect(without, high, { coffee: 1.6, cold_drink: 1.6, food: 1.6 });
    const limit = high.stored.items[0].factors.find((entry) => entry.key === 'factorLimit');
    expect(limit).toEqual(expect.objectContaining({ active: true }));
    expect(limit.reason).toMatch(/1\.6/);

    await Event.deleteMany({ cafeId: cafe._id });
    const low = await forecastWith({
      daySignals: { loadSheddingStage: 6 },
      weather: { ...MILD, temp: 31, maxTemp: 31, condition: 'Thundery showers', isRain: true, precipMm: 12, chanceOfRain: 95 },
    });
    // coffee 0.6 x (1 - 0.10 hot - 0.10 rain) = 0.48 raw, held at 0.5; food 0.6 x 0.9 = 0.54 stays.
    expectEffect(without, low, { coffee: 0.5, cold_drink: 0.72, food: 0.54 });
  });

  it('South African signals apply only to South African cafes', async () => {
    await Cafe.updateOne({ _id: cafe._id }, { $set: { 'location.country': 'United Kingdom' } });
    const without = await forecastWith();
    const saCalendar = await forecastWith({ daySignals: { isPayday: true, isPublicHoliday: true, loadSheddingStage: 4 } });
    expectEffect(without, saCalendar, { coffee: 1, cold_drink: 1, food: 1 });
    for (const key of ['holiday', 'payday', 'loadShedding']) {
      const factor = saCalendar.stored.factors.find((entry) => entry.key === key);
      expect({ key, active: factor.active, reason: factor.reason })
        .toEqual({ key, active: false, reason: 'Not available in your country' });
    }
    // Weather and events still apply outside South Africa.
    const hot = await forecastWith({ weather: { ...MILD, temp: 31, maxTemp: 31, condition: 'Sunny' } });
    expectEffect(without, hot, { cold_drink: 1.3, coffee: 0.9, food: 1 });
  });
});

describe('factor status: the Factors page never presents an unreachable provider as live', () => {
  const statusOf = async () => {
    const res = await supertest(app).get('/api/forecasts/factors').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.status.map((entry) => [entry.key, entry]));
  };

  it('load shedding without a provider key is not connected; calendar factors are built in', async () => {
    const saved = process.env.ESKOMSEPUSH_API_KEY;
    delete process.env.ESKOMSEPUSH_API_KEY;
    try {
      const status = await statusOf();
      expect(status.loadShedding).toEqual(expect.objectContaining({ state: 'not_connected', connected: false }));
      expect(status.loadShedding.reason).toMatch(/^Not connected/);
      expect(status.holiday).toEqual(expect.objectContaining({ state: 'built_in', connected: true }));
      expect(status.payday.state).toBe('built_in');
    } finally {
      if (saved !== undefined) process.env.ESKOMSEPUSH_API_KEY = saved;
    }
  });

  // W-05: a stored forecast does not keep the old plan's locks after a plan change; it is rebuilt under the current plan.
  it('regenerates the week after a plan change so factor locks follow the current plan', async () => {
    signals.getSignalsForDate.mockResolvedValue({ ...QUIET_SIGNALS, dayOfWeek: 1 });
    weatherService.getWeatherForecast.mockResolvedValue(MILD);
    if (weatherService.getWeatherForQuery) weatherService.getWeatherForQuery.mockResolvedValue(MILD);
    const lockOf = (res, key) => res.body.forecasts[0].factorEntitlements.factors.find((entry) => entry.key === key).unlocked;
    await Organization.updateMany({}, { plan: 'starter' });
    const before = await supertest(app).get('/api/forecasts/week').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);
    expect(lockOf(before, 'payday')).toBe(false);
    await Organization.updateMany({}, { plan: 'growth' });
    require('../../src/middleware/cache.middleware').clearApiCache({ cafeId: cafe._id });
    const after = await supertest(app).get('/api/forecasts/week').set('Authorization', `Bearer ${token}`);
    expect(after.body.forecasts[0].factorEntitlements.plan).toBe('growth');
    expect(lockOf(after, 'payday')).toBe(true);
  });

  it('a Starter cafe sees learning as on (overall correction), not locked', async () => {
    await Organization.updateMany({}, { plan: 'starter' });
    const status = await statusOf();
    expect(status.learning).toEqual(expect.objectContaining({
      state: 'built_in', connected: true, reason: 'Overall correction on; per-factor and per-item learning on Pro',
    }));
    expect(status.history.state).toBe('locked');
  });

  it('a cafe outside South Africa sees its South African signals as not available', async () => {
    await Cafe.updateOne({ _id: cafe._id }, { $set: { 'location.country': 'United Kingdom' } });
    const status = await statusOf();
    for (const key of ['holiday', 'payday', 'loadShedding']) {
      expect({ key, state: status[key].state, reason: status[key].reason })
        .toEqual({ key, state: 'not_available', reason: 'Not available in your country' });
    }
  });
});
