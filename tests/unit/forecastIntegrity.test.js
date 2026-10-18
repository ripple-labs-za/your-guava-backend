jest.mock('axios');

const axios = require('axios');
const express = require('express');
const supertest = require('supertest');
const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const Transaction = require('../../src/models/Transaction.model');
const Event = require('../../src/models/Event.model');
const Item = require('../../src/models/Item.model');
const Forecast = require('../../src/models/Forecast.model');
const { createForecastComputeLimiter, getLimiterOptions } = require('../../src/middleware/rateLimit.middleware');
const forecastService = require('../../src/services/forecast.service');
const { clearWeatherCache } = require('../../src/services/weather.service');
const { _test: controller } = require('../../src/controllers/forecasts.controller');
const { zonedDayStart } = require('../../src/utils/timezone');

const TZ = 'Africa/Johannesburg';
const TARGET = zonedDayStart('2030-03-06', TZ);
const query = (value) => {
  const chain = {
    select: () => chain, sort: () => chain, limit: () => chain, session: () => chain,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
};
const stubGeneration = (cafe) => {
  jest.spyOn(Cafe, 'findById').mockReturnValue(query({ _id: 'cafe-1', orgId: 'org-1', timezone: TZ, ...cafe }));
  jest.spyOn(Organization, 'findById').mockReturnValue(query({ plan: 'starter' }));
  jest.spyOn(Transaction, 'find').mockReturnValue(query([]));
  jest.spyOn(Transaction, 'findOne').mockReturnValue(query(null));
  jest.spyOn(Event, 'find').mockReturnValue(query([]));
  jest.spyOn(Item, 'find').mockReturnValue(query([]));
  jest.spyOn(Forecast, 'find').mockReturnValue(query([]));
  jest.spyOn(Forecast, 'findOne').mockReturnValue(query(null));
  jest.spyOn(Forecast, 'findOneAndUpdate').mockImplementation(async (_filter, update) => update.$set);
};

afterEach(() => jest.restoreAllMocks());

describe('forecast compute limiter', () => {
  it('limits forecast rebuilds per user, not per IP', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: req.get('X-User'), orgId: 'org-1' }; next(); });
    app.post('/generate', createForecastComputeLimiter({ limit: 2, windowMs: 60000, skip: () => false }), (_req, res) => res.json({ ok: true }));
    const request = supertest(app);

    expect((await request.post('/generate').set('X-User', 'a')).status).toBe(200);
    expect((await request.post('/generate').set('X-User', 'a')).status).toBe(200);
    const third = await request.post('/generate').set('X-User', 'a');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('FORECAST_RATE_LIMITED');
    expect((await request.post('/generate').set('X-User', 'b')).status).toBe(200);
  });

  it('exposes the production budget', () => {
    expect(getLimiterOptions('forecastCompute')).toEqual({ limit: 30, windowMs: 5 * 60 * 1000 });
  });
});

describe('menu-change re-scoring', () => {
  it('runs once more after a burst, not once per request', async () => {
    let runs = 0;
    const releases = [];
    const run = () => { runs += 1; return new Promise((resolve) => releases.push(resolve)); };

    const pending = Array.from({ length: 40 }, () => forecastService._test.runCoalescedMenuRefresh('cafe-1', run));
    expect(runs).toBe(1);
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(2); // one trailing run covers the 39 requests that arrived meanwhile
    releases.shift()();
    await Promise.all(pending);
    expect(runs).toBe(2);
  });
});

describe('provider outages', () => {
  const complete = {
    modelVersion: forecastService.FORECAST_MODEL_VERSION,
    generatedAt: new Date(),
    factors: ['weather', 'loadShedding', 'holiday', 'payday', 'events'].map((key) => ({ key, active: false })),
    factorSettings: {}, factorEntitlements: {}, calibration: { sampleSize: 0, overallMultiplier: 1 }, items: [],
    inputsVersion: 2,
    signals: { retryAfter: null },
  };

  it('refreshes a forecast once its retry time has passed, or when its inputs moved on', () => {
    const now = new Date();
    const later = new Date(now.getTime() + 5 * 60 * 1000);
    const earlier = new Date(now.getTime() - 60 * 1000);
    expect(controller.needsPlanningRefresh(complete, TZ, { inputsVersion: 2, now })).toBe(false);
    expect(controller.needsPlanningRefresh({ ...complete, signals: { retryAfter: later } }, TZ, { inputsVersion: 2, now })).toBe(false);
    expect(controller.needsPlanningRefresh({ ...complete, signals: { retryAfter: earlier } }, TZ, { inputsVersion: 2, now })).toBe(true);
    expect(controller.needsPlanningRefresh(complete, TZ, { inputsVersion: 3, now })).toBe(true);
  });

  it('schedules a retry 15 minutes out when the weather provider fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.WEATHER_API_KEY = 'test-weather-key';
    process.env.WEATHER_API_URL = 'https://api.weatherapi.com/v1';
    clearWeatherCache();
    axios.get.mockRejectedValue(new Error('timeout of 8000ms exceeded'));
    stubGeneration({ location: { lat: -26.2, lng: 28.0, city: 'Johannesburg' } });

    const before = Date.now();
    const forecast = await forecastService.generateForecast('cafe-1', TARGET);
    const wait = new Date(forecast.signals.retryAfter).getTime() - before;

    expect(wait).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
    expect(wait).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);
    process.env.WEATHER_API_KEY = '';
    process.env.WEATHER_API_URL = '';
    errorSpy.mockRestore();
  });

  it('does not schedule a retry for a provider that is simply not configured', async () => {
    stubGeneration({ location: { lat: -26.2, lng: 28.0, city: 'Johannesburg' } });
    const forecast = await forecastService.generateForecast('cafe-1', TARGET);
    expect(forecast.signals.retryAfter).toBeNull();
  });
});
