process.env.API_CACHE_ENABLED = 'true';
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const { clearApiCache } = require('../../src/middleware/cache.middleware');

const createdOrgIds = [];
const createCacheTestUser = async (...args) => {
  const owner = await createTestUser(...args);
  createdOrgIds.push(owner.user.orgId);
  return owner;
};
const request = supertest(app);
beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  process.env.API_CACHE_ENABLED = 'true';
  createdOrgIds.splice(0).forEach((orgId) => clearApiCache({ orgId }));
  await clearDB();
});

describe('API read cache with the cache on, as in production', () => {
  it('serves the second read from cache, and a mutation that calls clearApiCache invalidates it', async () => {
    const owner = await createCacheTestUser();
    const auth = { Authorization: `Bearer ${owner.token}` };

    const first = await request.get('/api/transactions/stats').set(auth);
    const second = await request.get('/api/transactions/stats').set(auth);
    expect(first.status).toBe(200);
    expect(first.headers['x-guava-cache']).toBe('miss');
    expect(second.headers['x-guava-cache']).toBe('hit');
    expect(second.body).toEqual(first.body);

    const event = await request.post('/api/events').set(auth).send({ name: 'Market Day', date: '2026-12-01', impact: 'high' });
    expect(event.status).toBe(201);
    const third = await request.get('/api/transactions/stats').set(auth);
    expect(third.headers['x-guava-cache']).toBe('miss');
  });

  it('never serves one organisation a read cached for another', async () => {
    const a = await createCacheTestUser({ email: 'cache-a@yourguava.com', cafeName: 'Cafe A', orgName: 'Org A' });
    const b = await createCacheTestUser({ email: 'cache-b@yourguava.com', cafeName: 'Cafe B', orgName: 'Org B' });
    await request.get('/api/transactions/stats').set('Authorization', `Bearer ${a.token}`);
    const other = await request.get('/api/transactions/stats').set('Authorization', `Bearer ${b.token}`);
    expect(other.headers['x-guava-cache']).toBe('miss');
  });

  it('bypasses the cache entirely when API_CACHE_ENABLED=false', async () => {
    process.env.API_CACHE_ENABLED = 'false';
    const owner = await createCacheTestUser();
    const auth = { Authorization: `Bearer ${owner.token}` };
    await request.get('/api/transactions/stats').set(auth);
    const again = await request.get('/api/transactions/stats').set(auth);
    expect(again.headers['x-guava-cache']).toBeUndefined();
  });
});
