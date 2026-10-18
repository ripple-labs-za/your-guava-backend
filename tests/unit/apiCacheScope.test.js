const { apiCache, clearApiCache } = require('../../src/middleware/cache.middleware');

const analytics = apiCache({ ttlMs: 60000, keyPrefix: 'analytics' });
const forecasts = apiCache({ ttlMs: 60000, keyPrefix: 'forecasts' });

// Drives the middleware the way Express does and reports the X-Guava-Cache header it set.
const through = (middleware, { orgId = 'org-1', cafeId = 'cafe-a', userId = 'owner', path = '/revenue', query = {} } = {}) =>
  new Promise((resolve) => {
    const headers = {};
    const req = { method: 'GET', baseUrl: '/api/analytics', path, query, user: { orgId, cafeId, id: userId } };
    const res = {
      statusCode: 200,
      set(name, value) { headers[name] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ cache: headers['X-Guava-Cache'], body }); return this; },
    };
    middleware(req, res, () => res.json({ fresh: true }));
  });

describe('API cache scope', () => {
  const originalCacheEnabled = process.env.API_CACHE_ENABLED;

  beforeEach(() => {
    process.env.API_CACHE_ENABLED = 'true';
  });

  afterEach(() => {
    clearApiCache({ orgId: 'org-1' });
    clearApiCache({ orgId: 'org-2' });
    process.env.API_CACHE_ENABLED = originalCacheEnabled;
  });

  it('evicts only the written cafe, for every user of that cafe', async () => {
    await through(analytics, { cafeId: 'cafe-a', userId: 'owner' });
    await through(analytics, { cafeId: 'cafe-a', userId: 'manager' });
    await through(analytics, { cafeId: 'cafe-b', userId: 'owner' });
    expect((await through(analytics, { cafeId: 'cafe-a', userId: 'owner' })).cache).toBe('hit');

    expect(clearApiCache({ cafeId: 'cafe-a' })).toBe(2);

    expect((await through(analytics, { cafeId: 'cafe-a', userId: 'owner' })).cache).toBe('miss');
    expect((await through(analytics, { cafeId: 'cafe-a', userId: 'manager' })).cache).toBe('miss');
    expect((await through(analytics, { cafeId: 'cafe-b', userId: 'owner' })).cache).toBe('hit');
  });

  it('evicts a whole organisation and nothing else', async () => {
    await through(analytics, { orgId: 'org-1', cafeId: 'cafe-a' });
    await through(analytics, { orgId: 'org-1', cafeId: 'cafe-b' });
    await through(analytics, { orgId: 'org-2', cafeId: 'cafe-z' });

    clearApiCache({ orgId: 'org-1' });

    expect((await through(analytics, { orgId: 'org-1', cafeId: 'cafe-a' })).cache).toBe('miss');
    expect((await through(analytics, { orgId: 'org-1', cafeId: 'cafe-b' })).cache).toBe('miss');
    expect((await through(analytics, { orgId: 'org-2', cafeId: 'cafe-z' })).cache).toBe('hit');
  });

  it('evicts one key prefix of a cafe when asked', async () => {
    await through(analytics, { cafeId: 'cafe-a' });
    await through(forecasts, { cafeId: 'cafe-a', path: '/today' });

    clearApiCache({ cafeId: 'cafe-a', keyPrefix: 'analytics' });

    expect((await through(analytics, { cafeId: 'cafe-a' })).cache).toBe('miss');
    expect((await through(forecasts, { cafeId: 'cafe-a', path: '/today' })).cache).toBe('hit');
  });

  it('accepts ObjectId-like ids', async () => {
    await through(analytics, { cafeId: '507f1f77bcf86cd799439011' });
    expect(clearApiCache({ cafeId: { toString: () => '507f1f77bcf86cd799439011' } })).toBe(1);
  });

  it('refuses a global flush', () => {
    expect(() => clearApiCache()).toThrow(/cafeId|orgId/);
    expect(() => clearApiCache({})).toThrow(/cafeId|orgId/);
    expect(() => clearApiCache({ keyPrefix: 'analytics' })).toThrow(/cafeId|orgId/);
  });

  it('ignores query parameters the route does not read when it lists its own', async () => {
    const scoped = apiCache({ ttlMs: 60000, keyPrefix: 'analytics', keyParams: ['startDate', 'endDate', 'period', 'days'] });
    await through(scoped, { cafeId: 'cafe-k', query: { startDate: '2026-01-01', nonce: '1' } });

    expect((await through(scoped, { cafeId: 'cafe-k', query: { startDate: '2026-01-01', nonce: '2' } })).cache).toBe('hit');
    expect((await through(scoped, { cafeId: 'cafe-k', query: { startDate: '2026-01-02' } })).cache).toBe('miss');
  });
});
