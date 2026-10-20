const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const forecastService = require('../../src/services/forecast.service');
const { addZonedDays, zonedDayStart } = require('../../src/utils/timezone');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const TZ = 'Africa/Johannesburg';
const localDay = (offset) => addZonedDays(zonedDayStart(new Date(), TZ), offset, TZ);
const quietSignals = {
  weather: { temp: 20, condition: 'clear', humidity: 60 },
  loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [],
};

// UAT-10-S02 review: its past-retention check compared two empty lists, because the scratch cafe had no past forecast.
// A change of location, hours or timezone invalidates Planning forecasts from today on; a past day's forecast carries
// its actuals and accuracy (the forecast history) and must never be deleted with them.
describe('invalidating Planning forecasts keeps past days', () => {
  let token;
  let cafe;

  beforeEach(async () => {
    ({ token } = await createTestUser());
    cafe = await Cafe.findOneAndUpdate({}, { $set: { timezone: TZ } }, { new: true });
  });

  const seedYesterdayAndTomorrow = async () => {
    const past = await Forecast.create({
      cafeId: cafe._id, date: localDay(-1), generatedAt: new Date(), origin: 'live', items: [], signals: quietSignals,
      totalPredictedRevenue: 100, actualRevenue: 90, actualsUpdatedAt: new Date(), accuracy: 90,
    });
    const future = await Forecast.create({
      cafeId: cafe._id, date: localDay(1), generatedAt: new Date(), origin: 'live', items: [], signals: quietSignals,
      totalPredictedRevenue: 120,
    });
    return { past: await Forecast.findById(past._id).lean(), futureId: future._id };
  };

  it('deletes tomorrow and leaves yesterday unchanged, by id and contents', async () => {
    const { past, futureId } = await seedYesterdayAndTomorrow();

    await forecastService.invalidatePlanningForecasts(cafe._id, { timezone: TZ });

    expect(await Forecast.findById(past._id).lean()).toEqual(past);
    expect(await Forecast.findById(futureId).lean()).toBeNull();
  });

  it('keeps yesterday when the owner moves the cafe to new coordinates', async () => {
    const { past, futureId } = await seedYesterdayAndTomorrow();

    const res = await request.put('/api/cafe/me').set('Authorization', `Bearer ${token}`)
      .send({ location: { lat: -33.9249, lng: 18.4241 } });

    expect(res.status).toBe(200);
    expect(await Forecast.findById(past._id).lean()).toEqual(past);
    expect(await Forecast.findById(futureId).lean()).toBeNull();
  });
});
