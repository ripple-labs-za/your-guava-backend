const mongoose = require('mongoose');
const logger = require('../../src/utils/logger');
const supertest = require('supertest');
const { setup, teardown, clearDB, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
const READINESS_TOKEN = 'r'.repeat(40);
// Details need the readiness token after BE-02-T06; these tests read checks, so they send it.
beforeAll(() => { process.env.READINESS_TOKEN = READINESS_TOKEN; });
afterAll(teardown);
afterEach(clearDB);

describe('Observability', () => {
  it('refuses new work on a reused socket with 503 Connection close while draining', async () => {
    const http = require('http');
    const lifecycle = require('../../src/utils/lifecycle');
    const server = http.createServer(app);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const sockets = new Set();
    server.on('connection', (socket) => sockets.add(socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const get = (path) => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.address().port, path, agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    try {
      expect((await get('/api/health')).status).toBe(200);
      lifecycle.markDraining();
      const response = await get('/api/health');
      expect(sockets.size).toBe(1);
      expect(response.status).toBe(503);
      expect(response.headers.connection).toBe('close');
      expect(response.headers['x-request-id']).toBeDefined();
      const unknown = await request.post('/api/not-a-route').set('Content-Type', 'application/json').send('{');
      expect(unknown.status).toBe(503);
      expect(unknown.headers.connection).toBe('close');
    } finally {
      lifecycle.resetLifecycleForTests();
      agent.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
it('issues its own request id and echoes a well-formed client id separately', async () => {
  const res = await request.get('/api/health').set('X-Request-Id', 'launch-smoke-req-001');
  expect(res.status).toBe(200);
  expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(res.headers['x-client-request-id']).toBe('launch-smoke-req-001');
  expect(res.body).toEqual(expect.objectContaining({ success: true, status: 'ok', requestId: res.headers['x-request-id'] }));
});

  it('reports readiness with database and env checks', async () => {
    const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database).toEqual(
      expect.objectContaining({ ok: true, state: 'connected' })
    );
    expect(res.body.checks.environment).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('logs the mounted request path without the query string', async () => {
    // Request logs are off in tests (tests/env.js); switch them on for one request.
    const previousRequestLogs = process.env.REQUEST_LOGS_ENABLED;
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    process.env.REQUEST_LOGS_ENABLED = 'true';
    let entries;
    try {
      await request.get('/api/auth/me').query({ token: 'should-not-be-logged' });
      await new Promise((resolve) => setImmediate(resolve));
      entries = infoSpy.mock.calls.filter(([event]) => event === 'http_request').map(([, fields]) => fields);
    } finally {
      process.env.REQUEST_LOGS_ENABLED = previousRequestLogs;
      infoSpy.mockRestore();
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: 'GET', path: '/api/auth/me', statusCode: 401 });
    expect(JSON.stringify(entries[0])).not.toContain('should-not-be-logged');
  });

  it('returns JSON 404 responses with request IDs for unknown API routes', async () => {
    const requestId = 'unknown-route-req-001';

    const res = await request
      .get('/api/not-a-real-route')
      .set('X-Request-Id', requestId);

    expect(res.status).toBe(404);
    expect(res.headers['x-client-request-id']).toBe(requestId);
    expect(res.body).toEqual({
      success: false,
      message: 'Route not found',
      requestId: res.headers['x-request-id'],
    });
  });

  describe('readiness reports product capability, not just env presence', () => {
    // Snapshot inside beforeAll, not in the describe body: the body is evaluated
    // before beforeAll(setup) runs, so at that point MONGODB_URI (set by
    // mongodb-memory-server) does not exist yet and a restore would delete it,
    // making every later readiness call 503 on checks.environment for a reason
    // unrelated to the assertion. Restore by key, never `process.env = {...}`:
    // replacing the object strands every module that captured a reference.
    // A populated local .env masked both mistakes; CI caught them.
    let ENV;
    beforeAll(() => { ENV = { ...process.env }; });
    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in ENV)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
    });

    it('reports email ready outside production via the console transport', async () => {
      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.checks.email).toEqual(
        expect.objectContaining({ ok: true, mode: 'console' })
      );
    });

    it('reports email NOT ready when production has no Resend credentials', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_FROM_EMAIL;

      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks.email.ok).toBe(false);
      expect(res.body.checks.email.configured).toBe(false);
      expect(res.body.checks.email.reason).toMatch(/RESEND_API_KEY/);
    });

    it('reports payments NOT ready when production has no provider', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.PAYMENT_PROVIDER;

      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);

      expect(res.status).toBe(503);
      expect(res.body.checks.payments.ok).toBe(false);
      expect(res.body.checks.payments.reason).toMatch(/PAYMENT_PROVIDER/);
    });

    it('names the selected provider when one is configured', async () => {
      process.env.PAYMENT_PROVIDER = 'paystack';
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_readiness_probe';

      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);

      expect(res.body.checks.payments).toEqual(
        expect.objectContaining({ ok: true, provider: 'paystack' })
      );
    });

    it('does not gate readiness on payments outside production', async () => {
      delete process.env.PAYMENT_PROVIDER;
      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.checks.payments.ok).toBe(true);
    });
  });
  it('reports event-loop lag on readiness without letting it decide readiness', async () => {
    const { startEventLoopMonitor, stopEventLoopMonitor } = require('../../src/utils/eventLoopMonitor');
    const idle = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
    expect(idle.body.checks.eventLoop).toEqual(expect.objectContaining({ ok: true, running: false, p99Ms: null }));

    startEventLoopMonitor({ intervalMs: 50, log: () => {} });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const res = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.checks.eventLoop).toEqual(expect.objectContaining({
        ok: true, running: true, p50Ms: expect.any(Number), p99Ms: expect.any(Number),
        maxMs: expect.any(Number), windowMs: expect.any(Number), degraded: expect.any(Boolean),
      }));
    } finally {
      stopEventLoopMonitor();
    }
  });
});

describe('readiness during shutdown and outages', () => {
  it('answers 503 draining once shutdown has begun', async () => {
    const lifecycle = require('../../src/utils/lifecycle');
    lifecycle.markDraining();
    try {
      const res = await request.get('/api/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('draining');
    } finally {
      lifecycle.resetLifecycleForTests();
    }
  });

  it('answers 503 while the database is disconnected and 200 again after it reconnects', async () => {
    // The token takes BE-02-T06's detailed path, which computes readiness on every call. Anonymous readiness is cached
    // for 5 s, so without it a result cached by an earlier test in this file could answer both requests.
    await mongoose.disconnect();
    try {
      const down = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
      expect(down.status).toBe(503);
      expect(down.body.success).toBe(false);
    } finally {
      await mongoose.connect(process.env.MONGODB_URI);
    }
    const up = await request.get('/api/ready').set('X-Readiness-Token', READINESS_TOKEN);
    expect(up.status).toBe(200);
  });
});
