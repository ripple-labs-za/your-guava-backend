// W-11 (walk): the global limiter (600 per 5 min) was keyed by IP alone, so a cafe's staff behind one NAT shared one
// budget. Authenticated requests are now keyed by the verified user; anonymous ones keep the address. A token that does
// not verify (forged, expired) is counted against the address, so it can never mint fresh buckets.
const express = require('express');
const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const { createGlobalLimiter, globalLimiterKey } = require('../../src/middleware/rateLimit.middleware');

const SECRET = 'test-jwt-secret-for-the-global-limiter';
const originalSecret = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = SECRET; });
afterAll(() => { if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret; });

const bearer = (id, secret = SECRET, options = { expiresIn: '15m' }) => `Bearer ${jwt.sign({ id }, secret, options)}`;
const reqWith = (authorization) => ({ headers: authorization ? { authorization } : {}, ip: '203.0.113.7' });

describe('global limiter key', () => {
  it('keys a verified token by its user and an anonymous request by its address', () => {
    expect(globalLimiterKey(reqWith(bearer('user-a')))).toBe('user:user-a');
    expect(globalLimiterKey(reqWith(bearer('user-b')))).toBe('user:user-b');
    expect(globalLimiterKey(reqWith())).toMatch(/^ip:/);
  });

  it('counts a forged or expired token against the address', () => {
    expect(globalLimiterKey(reqWith(bearer('user-a', 'not-the-secret')))).toMatch(/^ip:/);
    expect(globalLimiterKey(reqWith(bearer('user-a', SECRET, { expiresIn: -10 })))).toMatch(/^ip:/);
    expect(globalLimiterKey(reqWith('Bearer not-a-jwt'))).toMatch(/^ip:/);
  });
});

describe('global limiter budgets', () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(createGlobalLimiter({ limit: 2, addressLimit: 100, skip: () => false }));
  app.get('/ping', (req, res) => res.json({ ok: true }));
  const request = supertest(app);

  it('still caps one address however many accounts it signs in with', async () => {
    const ceilingApp = express();
    ceilingApp.use(createGlobalLimiter({ limit: 10, addressLimit: 3, skip: () => false }));
    ceilingApp.get('/ping', (req, res) => res.json({ ok: true }));
    const ceiling = supertest(ceilingApp);
    const statuses = [];
    for (const id of ['farm-1', 'farm-2', 'farm-3', 'farm-4']) {
      statuses.push((await ceiling.get('/ping').set('Authorization', bearer(id))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('gives two signed-in users behind one address a budget each', async () => {
    const a = bearer('user-a');
    const b = bearer('user-b');
    expect((await request.get('/ping').set('Authorization', a)).status).toBe(200);
    expect((await request.get('/ping').set('Authorization', a)).status).toBe(200);
    expect((await request.get('/ping').set('Authorization', a)).status).toBe(429);
    expect((await request.get('/ping').set('Authorization', b)).status).toBe(200);
    expect((await request.get('/ping')).status).toBe(200);
  });
});
