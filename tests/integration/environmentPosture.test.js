const logger = require('../../src/utils/logger');
const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const { _resetReadinessCache } = require('../../src/controllers/health.controller');

const request = supertest(app);
const READINESS_TOKEN = 'r'.repeat(40);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const withEnv = async (overrides, fn) => {
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

describe('origin checks run in every non-test environment', () => {
  it.each(['development', 'staging', 'production'])('NODE_ENV=%s refuses foreign and missing origins', async (nodeEnv) => {
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    // The test env switches origin checks off (tests/env.js); these cases exist to prove they are on.
    await withEnv({ NODE_ENV: nodeEnv, CLIENT_URL: 'http://localhost:5185', ORIGIN_CHECKS_ENABLED: 'true' }, async () => {
      const body = { email: 'nobody@yourguava.com', password: 'password123' };
      expect((await request.post('/api/auth/login').set('Origin', 'http://evil.example').send(body)).status).toBe(403);
      expect((await request.post('/api/auth/login').send(body)).status).toBe(403);
      expect((await request.post('/api/auth/login').set('Origin', 'http://localhost:5185').send(body)).status).toBe(401);
    });
  });
});

describe('the console transport never reports a delivery it did not make', () => {
  it('answers register 202 with deliveryMode console in the test environment', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = await request.post('/api/auth/register')
      .send({ name: 'Console Owner', email: 'console@yourguava.com', password: 'password123', cafeName: 'Console Cafe' });
    expect(res.status).toBe(202);
    expect(res.body.deliveryMode).toBe('console');
  });

  it('keeps the invitation usable for local testing but says no email was sent', async () => {
    const owner = await createTestUser({ email: 'console-owner@yourguava.com' });
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = await request.post('/api/team/invite').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Console Manager', email: 'console-manager@yourguava.com', cafeIds: [owner.user.activeCafeId] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ emailSent: false, deliveryMode: 'console' }));
    expect((await TeamInvitation.findOne({ email: 'console-manager@yourguava.com' }).lean()).status).toBe('pending');
  });
});

describe('public readiness returns status only', () => {
  beforeEach(() => _resetReadinessCache());

  it('hides every detail from anonymous callers and from a wrong token', async () => {
    await withEnv({ READINESS_TOKEN }, async () => {
      for (const token of [undefined, 'wrong-token', 'r'.repeat(39)]) {
        const req = request.get('/api/ready');
        const res = token ? await req.set('X-Readiness-Token', token) : await req;
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['requestId', 'status', 'success']);
      }
      const health = await request.get('/api/health');
      expect(health.body.version).toBeUndefined();
      expect(health.body.environment).toBeUndefined();
      expect(health.body.uptimeSeconds).toBeUndefined();
    });
  });

  it('shows the checks to a caller with the readiness token', async () => {
    await withEnv({ READINESS_TOKEN }, async () => {
      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.checks.database).toEqual(expect.objectContaining({ ok: true }));
      expect(res.body.checks.email).toEqual(expect.objectContaining({ mode: 'console' }));
      expect(res.body.environment).toBe('test');
    });
  });

  it('never shows details when no readiness token is configured', async () => {
    await withEnv({ READINESS_TOKEN: '' }, async () => {
      const res = await request.get('/api/ready').set('X-Readiness-Token', '');
      expect(Object.keys(res.body).sort()).toEqual(['requestId', 'status', 'success']);
    });
  });

  it('answers 503, never 500, when the probe itself throws, and recovers in the next window', async () => {
    const r2 = require('../../src/services/r2.service');
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    const broken = jest.spyOn(r2, 'getConfigurationStatus').mockImplementation(() => { throw new Error('probe exploded'); });
    await withEnv({ READINESS_TOKEN }, async () => {
      const anonymous = await request.get('/api/ready');
      expect(anonymous.status).toBe(503);
      expect(anonymous.body).toEqual({ success: false, status: 'not_ready', requestId: expect.any(String) });
      const detailed = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
      expect(detailed.status).toBe(503);
      expect(detailed.body.status).toBe('not_ready');
      expect(JSON.stringify(detailed.body)).not.toContain('probe exploded');

      broken.mockRestore();
      _resetReadinessCache();
      expect((await request.get('/api/ready')).status).toBe(200);
    });
  });

  it('runs the probe at most once per 5 s for anonymous callers', async () => {
    const admin = jest.spyOn(mongoose.connection.db, 'admin');
    const responses = await Promise.all(Array.from({ length: 50 }, () => request.get('/api/ready')));
    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(admin.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
