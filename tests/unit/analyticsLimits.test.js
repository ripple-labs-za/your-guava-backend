const express = require('express');
const supertest = require('supertest');
const {
  createAnalyticsLimiter,
  createAnalyticsRefreshLimiter,
  analyticsLimiter,
  analyticsRefreshLimiter,
  getLimiterOptions,
} = require('../../src/middleware/rateLimit.middleware');
const {
  analyticsMaxRangeDays,
  analyticsQueryMaxTimeMs,
  combosMaxBaskets,
  isQueryTimeout,
} = require('../../src/services/analytics/limits');

const appWith = (limiter) => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: req.get('x-user') || 'user-a', orgId: 'org-1' };
    next();
  });
  app.use(limiter);
  app.get('/api/analytics/revenue', (_req, res) => res.json({ success: true }));
  return app;
};

describe('analytics rate limits', () => {
  it('limits each user separately and names the limit in the 429', async () => {
    const request = supertest(appWith(createAnalyticsLimiter({ limit: 3, skip: () => false })));
    for (let i = 0; i < 3; i += 1) expect((await request.get('/api/analytics/revenue')).status).toBe(200);

    const limited = await request.get('/api/analytics/revenue');

    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('ANALYTICS_RATE_LIMITED');
    expect((await request.get('/api/analytics/revenue').set('x-user', 'user-b')).status).toBe(200);
  });

  it('lets ordinary reads through but limits refresh=true', async () => {
    const request = supertest(appWith(createAnalyticsRefreshLimiter({ limit: 2, skip: () => false })));
    for (let i = 0; i < 5; i += 1) expect((await request.get('/api/analytics/revenue')).status).toBe(200);
    expect((await request.get('/api/analytics/revenue?refresh=true')).status).toBe(200);
    expect((await request.get('/api/analytics/revenue?refresh=true')).status).toBe(200);

    const limited = await request.get('/api/analytics/revenue?refresh=true');

    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('ANALYTICS_REFRESH_RATE_LIMITED');
  });

  it('publishes the production budgets', () => {
    expect(getLimiterOptions('analytics')).toEqual({ limit: 60, windowMs: 60000 });
    expect(getLimiterOptions('analyticsRefresh')).toEqual({ limit: 6, windowMs: 60000 });
  });

  it('puts both limiters in front of every analytics route', () => {
    const router = require('../../src/routes/analytics.routes');
    const handles = router.stack.map((layer) => layer.handle);
    const firstRoute = router.stack.findIndex((layer) => layer.route);

    expect(firstRoute).toBeGreaterThan(-1);
    expect(handles.indexOf(analyticsLimiter)).toBeGreaterThan(-1);
    expect(handles.indexOf(analyticsLimiter)).toBeLessThan(firstRoute);
    expect(handles.indexOf(analyticsRefreshLimiter)).toBeGreaterThan(-1);
    expect(handles.indexOf(analyticsRefreshLimiter)).toBeLessThan(firstRoute);
  });
});

describe('analytics limits from the environment', () => {
  afterEach(() => {
    delete process.env.ANALYTICS_MAX_RANGE_DAYS;
    delete process.env.ANALYTICS_QUERY_MAX_TIME_MS;
    delete process.env.COMBOS_MAX_BASKETS;
  });

  it('defaults to 400 days, 20 seconds and 20,000 baskets', () => {
    expect(analyticsMaxRangeDays()).toBe(400);
    expect(analyticsQueryMaxTimeMs()).toBe(20000);
    expect(combosMaxBaskets()).toBe(20000);
  });

  it('accepts a configured value inside the hard bounds and ignores anything else', () => {
    process.env.ANALYTICS_MAX_RANGE_DAYS = '90';
    expect(analyticsMaxRangeDays()).toBe(90);
    process.env.ANALYTICS_MAX_RANGE_DAYS = '5000';
    expect(analyticsMaxRangeDays()).toBe(400);
    process.env.ANALYTICS_MAX_RANGE_DAYS = 'lots';
    expect(analyticsMaxRangeDays()).toBe(400);
  });

  it('recognises a MongoDB time-limit error and nothing else', () => {
    expect(isQueryTimeout({ code: 50 })).toBe(true);
    expect(isQueryTimeout({ codeName: 'MaxTimeMSExpired' })).toBe(true);
    expect(isQueryTimeout(new Error('network'))).toBe(false);
    expect(isQueryTimeout(undefined)).toBe(false);
  });
});
