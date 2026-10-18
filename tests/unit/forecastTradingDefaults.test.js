const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const Event = require('../../src/models/Event.model');
const Item = require('../../src/models/Item.model');
const Forecast = require('../../src/models/Forecast.model');
const { generateForecast, _test: forecastMath } = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart } = require('../../src/utils/timezone');

const TZ = 'Africa/Johannesburg';
const SUNDAY = zonedDayStart('2030-03-10', TZ);
const WEDNESDAY = zonedDayStart('2030-03-06', TZ);

const query = (value) => {
  const chain = {
    select: () => chain, sort: () => chain, limit: () => chain, session: () => chain,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
};
const at = (target, daysBefore, hour) => new Date(addZonedDays(target, -daysBefore, TZ).getTime() + hour * 3600 * 1000);
const openAllWeek = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: true, openTime: '07:00', closeTime: '17:00' }));

const stubModels = ({ cafe = {}, transactions = [], latestSale = null, events = [] } = {}) => {
  jest.spyOn(Cafe, 'findById').mockReturnValue(query({ _id: 'cafe-1', orgId: 'org-1', timezone: TZ, ...cafe }));
  jest.spyOn(Organization, 'findById').mockReturnValue(query({ plan: 'starter' }));
  jest.spyOn(Transaction, 'find').mockReturnValue(query(transactions));
  jest.spyOn(Transaction, 'findOne').mockReturnValue(query(latestSale));
  jest.spyOn(Event, 'find').mockReturnValue(query(events));
  jest.spyOn(Item, 'find').mockReturnValue(query([{ name: 'Flat White', category: 'coffee', avgPrice: 30 }]));
  jest.spyOn(Forecast, 'find').mockReturnValue(query([]));
  jest.spyOn(Forecast, 'findOne').mockReturnValue(query(null));
  jest.spyOn(Forecast, 'findOneAndUpdate').mockImplementation(async (_filter, update) => update.$set);
};
const sundaySales = () => Array.from({ length: 8 }, (_, i) => ({
  date: at(SUNDAY, 7 * (i + 1), 9), dayOfWeek: 0, hour: 9, status: 'approved',
  items: [{ name: 'Flat White', quantity: 10, unitPrice: 30 }],
}));

afterEach(() => jest.restoreAllMocks());

it('keeps ignored POS lines and unknown hours out of the hourly demand profile', () => {
  const { buildHourlyProfile } = require('../../src/services/forecast/history');
  const profile = buildHourlyProfile([
    { hour: 7, items: [{ name: 'Coffee', quantity: 10 }, { name: 'Cash out', quantity: 90, menuItemStatus: 'ignored' }] },
    { hour: 8, hourKnown: false, items: [{ name: 'Coffee', quantity: 20 }] },
  ]);
  expect([...profile]).toEqual([[7, 10]]);
});

describe('trading hours a cafe never saved', () => {
  it('treats a default-closed day as open when the cafe’s own sales show it trades', async () => {
    stubModels({ transactions: sundaySales() }); // no tradingHours on the cafe

    const forecast = await generateForecast('cafe-1', SUNDAY);

    expect(forecast.availability).toEqual(expect.objectContaining({ status: 'ready', scheduleSource: 'inferred_from_sales' }));
    expect(forecast.items[0].expectedQty).toBeCloseTo(10, 4);
  });

  it('keeps a closed day closed when the owner saved it that way', async () => {
    const closedSunday = openAllWeek.map((day) => (day.dayOfWeek === 0 ? { ...day, isOpen: false } : day));
    stubModels({ cafe: { tradingHours: closedSunday }, transactions: sundaySales() });

    const forecast = await generateForecast('cafe-1', SUNDAY);

    expect(forecast.availability).toEqual(expect.objectContaining({ status: 'closed', contradictsHistory: true, scheduleSource: 'saved' }));
  });
});

describe('partial closures', () => {
  // 100 units a Wednesday between 07:00 and 17:00, half of them before 10:00.
  const breakfastHeavy = new Map([[7, 20], [8, 20], [9, 10], [10, 10], [11, 10], [12, 10], [13, 5], [14, 5], [15, 5], [16, 5]]);
  const cafe = { tradingHours: openAllWeek };
  const breakfastClosure = [{ name: 'Plumber', type: 'partial_closure', closureWindow: { startTime: '07:00', endTime: '10:00' } }];

  it('weights a closure by the share of sales in the closed hours', () => {
    const trading = forecastMath.getTradingAvailability(cafe, breakfastClosure, 3, { hourlyProfile: breakfastHeavy });
    // 50 of 100 units fall in 07:00-10:00; minutes alone say 180 of 600.
    expect(trading).toEqual(expect.objectContaining({ status: 'ready', multiplier: 0.5, closedShareMethod: 'hourly_sales' }));
  });

  it('falls back to the share of minutes when the hourly history is thin', () => {
    const thin = new Map([[7, 2], [8, 2], [12, 2]]);
    const trading = forecastMath.getTradingAvailability(cafe, breakfastClosure, 3, { hourlyProfile: thin });
    expect(trading).toEqual(expect.objectContaining({ multiplier: 0.7, closedShareMethod: 'minutes' }));
  });

  it('builds the profile from the weekday history inside generateForecast', async () => {
    const transactions = [];
    for (let week = 1; week <= 8; week += 1) {
      for (const [hour, units] of breakfastHeavy.entries()) {
        transactions.push({
          date: at(WEDNESDAY, 7 * week, hour), dayOfWeek: 3, hour, status: 'approved',
          items: [{ name: 'Flat White', quantity: units, unitPrice: 30 }],
        });
      }
    }
    stubModels({
      cafe,
      transactions,
      events: [{ ...breakfastClosure[0], date: new Date(Date.UTC(2030, 2, 6)) }],
    });

    const forecast = await generateForecast('cafe-1', WEDNESDAY);

    expect(forecast.factors.find((factor) => factor.key === 'tradingHours').multiplier).toBe(0.5);
    expect(forecast.items[0].expectedQty).toBeCloseTo(50, 4);
  });

  it('removes historical closure effects with the same hourly profile used for a future closure', async () => {
    const transactions = [];
    for (let week = 1; week <= 8; week += 1) {
      for (const [hour, units] of breakfastHeavy) {
        // The most recent Wednesday lost its breakfast sales to the recorded closure.
        if (week === 1 && hour < 10) continue;
        transactions.push({
          date: at(WEDNESDAY, 7 * week, hour), dayOfWeek: 3, hour,
          items: [{ name: 'Flat White', quantity: units, unitPrice: 30 }],
        });
      }
    }
    stubModels({
      cafe, transactions,
      events: [{ ...breakfastClosure[0], date: new Date(Date.UTC(2030, 1, 27)) }],
    });

    const forecast = await generateForecast('cafe-1', WEDNESDAY);

    // The pooled profile has 350 breakfast and 400 later units: open share 0.5333.
    // Recent-week weight is 0.35. Minutes (0.7) would incorrectly leave only 90 units.
    expect(forecast.items[0].expectedQty).toBeCloseTo(100 * 0.65 + (50 / 0.5333) * 0.35, 3);
  });
});

describe('staleness', () => {
  it('counts from the latest sale, even when it is outside the weekday window', async () => {
    stubModels({ cafe: { tradingHours: openAllWeek }, transactions: [], latestSale: { date: at(WEDNESDAY, 60, 12) } });
    const forecast = await generateForecast('cafe-1', WEDNESDAY);
    // The weekday window (8 weeks) is empty, so the old code reported undefined and the stale notice never showed.
    expect(forecast.trainingData.staleDays).toBe(60);
    expect(forecast.trainingData.latestSaleDate).toEqual(at(WEDNESDAY, 60, 12));
  });

  it('reports one day for a cafe with sales up to yesterday', async () => {
    stubModels({ cafe: { tradingHours: openAllWeek }, transactions: [], latestSale: { date: at(WEDNESDAY, 1, 15) } });
    const forecast = await generateForecast('cafe-1', WEDNESDAY);
    expect(forecast.trainingData.staleDays).toBe(1);
  });
});
