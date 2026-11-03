// W-1, L-2, F-2, F-3, F-6 (release 3): weather is kept per cafe per local day, observed weather replaces the forecast
// once the day closes, and the nightly job runs once per cafe-day. WeatherAPI is stubbed; no real provider call.
jest.mock('axios');
const axios = require('axios');
const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const WeatherDay = require('../../src/models/WeatherDay.model');
const JobRun = require('../../src/models/JobRun.model');
const { clearWeatherCache, weatherQueryForCafe, getWeatherForQuery } = require('../../src/services/weather.service');
const { generateForecastsForDates } = require('../../src/services/forecast/generate');
const { loadStoredSignalsByDateKey } = require('../../src/services/forecast/history');
const { runNightlyForCafe, runNightlyLearning } = require('../../src/services/forecast/nightly');
const { addZonedDays, zonedDateKey, zonedDayStart } = require('../../src/utils/timezone');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const TZ = 'Africa/Johannesburg';
const key = (offset) => zonedDateKey(addZonedDays(zonedDayStart(new Date(), TZ), offset, TZ), TZ);
const day = (date, temp, maxTemp) => ({
  date, day: { avgtemp_c: temp, maxtemp_c: maxTemp, avghumidity: 50, totalprecip_mm: 0, condition: { text: 'Sunny' } },
});
// The account's plan returns three forecast days (F-3); history returns the observed day asked for.
const stubProvider = () => axios.get.mockImplementation(async (url, config) => {
  if (url.endsWith('/history.json')) return { data: { forecast: { forecastday: [day(config.params.dt, 30, 33)] } } };
  return { data: { forecast: { forecastday: [day(key(0), 15, 18), day(key(1), 16, 19), day(key(2), 17, 20)] } } };
});

const originalKey = process.env.WEATHER_API_KEY;
const originalUrl = process.env.WEATHER_API_URL;
let cafe;

beforeEach(async () => {
  jest.clearAllMocks();
  clearWeatherCache();
  process.env.WEATHER_API_KEY = 'test-weather-key';
  process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
  stubProvider();
  await createTestUser();
  cafe = await Cafe.findOneAndUpdate({}, {
    $set: { timezone: TZ, dataUploaded: true, location: { lat: -33.92, lng: 18.42, city: 'Cape Town', country: 'South Africa' } },
  }, { new: true }).lean();
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.WEATHER_API_KEY; else process.env.WEATHER_API_KEY = originalKey;
  if (originalUrl === undefined) delete process.env.WEATHER_API_URL; else process.env.WEATHER_API_URL = originalUrl;
});

describe('weather kept per cafe per day (W-1)', () => {
  it('stores the forecast for days ahead and says a day beyond the provider plan is not available yet (F-3)', async () => {
    const targets = [0, 1, 5].map((offset) => addZonedDays(zonedDayStart(new Date(), TZ), offset, TZ));
    await generateForecastsForDates(cafe._id, targets, { origin: 'live' });

    const stored = await WeatherDay.find({ cafeId: cafe._id }).sort({ dateKey: 1 }).lean();
    expect(stored.map((doc) => doc.dateKey)).toEqual([key(0), key(1)]);
    expect(stored[0].forecast).toMatchObject({ available: true, temp: 15, maxTemp: 18 });
    expect(stored[0].observed).toBeUndefined();
    expect(stored[0].query).toBe('-33.92,18.42');

    const farDay = await Forecast.findOne({ cafeId: cafe._id, dateKey: key(5) }).lean();
    expect(farDay.signals.weather).toMatchObject({ available: false, unavailableReason: 'Weather not available yet' });
  });

  it('keeps one record per cafe and day: a second forecast updates it, never duplicates it', async () => {
    const today = zonedDayStart(new Date(), TZ);
    await generateForecastsForDates(cafe._id, [today], { origin: 'live' });
    clearWeatherCache();
    await generateForecastsForDates(cafe._id, [today], { origin: 'live' });
    expect(await WeatherDay.countDocuments({ cafeId: cafe._id, dateKey: key(0) })).toBe(1);
  });

  it('de-weathers a closed day with the observed weather, not the forecast made for it', async () => {
    await Forecast.create({
      cafeId: cafe._id, date: addZonedDays(zonedDayStart(new Date(), TZ), -1, TZ), dateKey: key(-1), generatedAt: new Date(),
      origin: 'live', items: [], totalPredictedRevenue: 0,
      signals: { weather: { available: true, temp: 15, maxTemp: 18, condition: 'Cloudy', humidity: 50 }, events: [] },
    });
    await WeatherDay.create({
      cafeId: cafe._id, dateKey: key(-1), observed: { available: true, temp: 30, maxTemp: 33, condition: 'Sunny', humidity: 40, fetchedAt: new Date() },
    });
    const signals = await loadStoredSignalsByDateKey(cafe._id, [key(-1)]);
    expect(signals.get(key(-1)).weather).toMatchObject({ temp: 30, maxTemp: 33, observed: true });
  });
});

describe('cafe-local dates and location fallback (F-2, F-6)', () => {
  it('asks for a cafe without coordinates by its city and country', async () => {
    expect(weatherQueryForCafe({ location: { city: 'Cape Town', country: 'South Africa' } })).toBe('Cape Town, South Africa');
    // The street address is never sent to the provider.
    expect(weatherQueryForCafe({ location: { address: '1 Long St' } })).toBeNull();
    expect(weatherQueryForCafe({ location: {} })).toBeNull();
    await getWeatherForQuery('Cape Town, South Africa', key(0), { timezone: TZ });
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/forecast.json'),
      expect.objectContaining({ params: expect.objectContaining({ q: 'Cape Town, South Africa' }) }));
  });

  it('treats yesterday in the cafe zone as past and asks history for it', async () => {
    await getWeatherForQuery('-33.92,18.42', key(-1), { timezone: TZ });
    expect(axios.get).toHaveBeenCalledWith(expect.stringContaining('/history.json'),
      expect.objectContaining({ params: expect.objectContaining({ dt: key(-1) }) }));
  });
});

describe('nightly learning job (L-2)', () => {
  it('scores, keeps a week of observed weather and rebuilds the plan, once per cafe-day', async () => {
    const first = await runNightlyForCafe(cafe);
    expect(first.status).toBe('done');
    expect(first.summary.weather.observed).toBe(7);
    expect(first.summary.regenerated).toBe(7);

    const observed = await WeatherDay.find({ cafeId: cafe._id, 'observed.available': true }).lean();
    expect(observed).toHaveLength(7);
    expect(observed.every((doc) => doc.observed.temp === 30)).toBe(true);
    const run = await JobRun.findOne({ key: `nightly:${cafe._id}:${key(-1)}` }).lean();
    expect(run).toMatchObject({ status: 'done', attempts: 1 });

    const historyCalls = axios.get.mock.calls.filter(([url]) => url.endsWith('/history.json')).length;
    const second = await runNightlyForCafe(cafe);
    expect(second.status).toBe('skipped');
    expect(axios.get.mock.calls.filter(([url]) => url.endsWith('/history.json')).length).toBe(historyCalls);
  });

  it('waits until 01:00 in the cafe zone before running a cafe', async () => {
    const earlyMorning = new Date(`${key(0)}T00:30:00+02:00`);
    const summary = await runNightlyLearning({ now: earlyMorning });
    expect(summary).toMatchObject({ waiting: 1, done: 0 });
    expect(await JobRun.countDocuments({})).toBe(0);
  });

  it('retries a failed cafe-day on the next tick', async () => {
    await JobRun.create({ key: `nightly:${cafe._id}:${key(-1)}`, status: 'failed', attempts: 1 });
    const retried = await runNightlyForCafe(cafe);
    expect(retried.status).toBe('done');
    expect(await JobRun.findOne({ key: `nightly:${cafe._id}:${key(-1)}` }).lean()).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('gives up on a cafe-day after three attempts and leaves it to the next night', async () => {
    await JobRun.create({ key: `nightly:${cafe._id}:${key(-1)}`, status: 'failed', attempts: 3 });
    expect((await runNightlyForCafe(cafe)).status).toBe('skipped');
  });

  it('backs off: a failed cafe-day is not retried before its retryAfter', async () => {
    await JobRun.create({
      key: `nightly:${cafe._id}:${key(-1)}`, status: 'failed', attempts: 1, retryAfter: new Date(Date.now() + 30 * 60 * 1000),
    });
    expect((await runNightlyForCafe(cafe)).status).toBe('skipped');
  });

  it('runs inside the night window and not after 05:00 local (a daytime deploy)', async () => {
    expect(await runNightlyLearning({ now: new Date(`${key(0)}T02:30:00+02:00`) })).toMatchObject({ done: 1 });
    const morning = new Date(`${key(0)}T07:16:00+02:00`);
    expect(await runNightlyLearning({ now: morning })).toMatchObject({ waiting: 1, done: 0 });
  });
});
