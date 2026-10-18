const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const Transaction = require('../../src/models/Transaction.model');
const { rescoreForecastAccuracy } = require('../../src/migrations/rescore-forecast-accuracy');
const { addZonedDays, zonedDayStart } = require('../../src/utils/timezone');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

it('adds item accuracy to days scored before it existed, and only with --apply', async () => {
  await createTestUser();
  const cafe = await Cafe.findOne({});
  const day = addZonedDays(zonedDayStart(new Date(), 'Africa/Johannesburg'), -1, 'Africa/Johannesburg');
  await Forecast.create({
    cafeId: cafe._id, date: day, generatedAt: new Date(), totalPredictedRevenue: 0, accuracy: 100, actualsUpdatedAt: new Date(),
    items: [{ itemName: 'Flat White', predictedQty: 100 }, { itemName: 'Muffin', predictedQty: 0 }],
    forecastCoverage: { itemCount: 2, storedItemCount: 2, totalPredictedQty: 100, includesAllRevenue: true },
  });
  await Transaction.create({
    cafeId: cafe._id, date: new Date(day.getTime() + 10 * 3600 * 1000), hour: 10, dayOfWeek: 0, status: 'approved', total: 100,
    items: [{ name: 'Flat White', quantity: 50, unitPrice: 1 }, { name: 'Muffin', quantity: 50, unitPrice: 1 }],
  });

  expect(await rescoreForecastAccuracy()).toEqual({ cafes: 1, scanned: 1, rescored: 0 });
  expect((await Forecast.findOne({ cafeId: cafe._id }).lean()).itemAccuracy).toBeUndefined();

  expect(await rescoreForecastAccuracy({ apply: true })).toEqual({ cafes: 1, scanned: 1, rescored: 1 });
  expect((await Forecast.findOne({ cafeId: cafe._id }).lean()).itemAccuracy).toBe(0);
  expect(await rescoreForecastAccuracy({ apply: true })).toEqual({ cafes: 1, scanned: 1, rescored: 1 });
  expect((await Forecast.findOne({ cafeId: cafe._id }).lean()).itemAccuracy).toBe(0);
});
