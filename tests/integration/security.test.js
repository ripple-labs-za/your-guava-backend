const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const User = require('../../src/models/User.model');
const Staff = require('../../src/models/Staff.model');
const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const AuthSession = require('../../src/models/AuthSession.model');
const { createOAuthState, verifyOAuthState } = require('../../src/services/yoco.service');
const { globalLimiter } = require('../../src/middleware/rateLimit.middleware');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  // Ensure a stray local .env value never leaks into webhook tests
  delete process.env.YOCO_INTEGRATION_ENABLED;
  delete process.env.YOCO_WEBHOOK_SECRET;
});
afterEach(async () => {
  jest.restoreAllMocks();
  delete process.env.YOCO_INTEGRATION_ENABLED;
  delete process.env.YOCO_WEBHOOK_SECRET;
  await clearDB();
});

describe('Legacy Yoco API surface', () => {
  it('does not expose the webhook route unless explicitly enabled', async () => {
    const res = await request.post('/api/yoco/webhook').send({ event_type: 'payment.created' });
    expect(res.status).toBe(404);
  });

  it('does not expose the OAuth callback route unless explicitly enabled', async () => {
    const { token } = await createTestUser();
    const res = await request
      .post('/api/yoco/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'auth-code', state: 'forged-state' });
    expect(res.status).toBe(404);
  });
});

describe('Yoco OAuth state', () => {
  it('round-trips a valid state for the same cafe', () => {
    const state = createOAuthState('cafe123');
    expect(verifyOAuthState(state, 'cafe123')).toBe(true);
  });

  it('rejects state bound to a different cafe', () => {
    const state = createOAuthState('cafe123');
    expect(verifyOAuthState(state, 'othercafe')).toBe(false);
  });

  it('rejects tampered and malformed state', () => {
    const state = createOAuthState('cafe123');
    expect(verifyOAuthState(`${state}x`, 'cafe123')).toBe(false);
    expect(verifyOAuthState('garbage', 'cafe123')).toBe(false);
    expect(verifyOAuthState(undefined, 'cafe123')).toBe(false);
  });

});

describe('Refresh token rotation', () => {
  it('rotates the refresh cookie and keeps active session families bounded', async () => {
    const { user, cookie } = await createTestUser();

    const res = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();

    const newCookie = res.headers['set-cookie'];
    expect(newCookie).toBeDefined();
    expect(String(newCookie)).toContain('refreshToken=');

    expect(await AuthSession.countDocuments({
      userId: user.id,
      revokedAt: null,
    })).toBeLessThanOrEqual(10);

    // Run many refreshes — the list must stay bounded
    let currentCookie = newCookie;
    for (let i = 0; i < 12; i++) {
      const r = await request.post('/api/auth/refresh').set('Cookie', currentCookie);
      expect(r.status).toBe(200);
      currentCookie = r.headers['set-cookie'] || currentCookie;
    }
    expect(await AuthSession.countDocuments({
      userId: user.id,
      revokedAt: null,
    })).toBeLessThanOrEqual(10);
  });

  it('allows a concurrent duplicate briefly, then revokes a replayed refresh family', async () => {
    const { cookie } = await createTestUser();

    // First refresh succeeds and rotates the token
    const first = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(first.status).toBe(200);

    // A second tab can have sent the same cookie before the first response
    // arrived. It receives the same replacement rather than killing the login.
    const concurrent = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(concurrent.status).toBe(200);
    expect(String(concurrent.headers['set-cookie'])).toBe(String(first.headers['set-cookie']));

    await AuthSession.updateOne(
      { revokedAt: null },
      { $set: { previousValidUntil: new Date(Date.now() - 1000) } }
    );

    // Outside the concurrency grace, the consumed token is a replay signal.
    const replay = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    // Replay revokes the entire family, including its freshly issued token.
    const next = await request.post('/api/auth/refresh').set('Cookie', first.headers['set-cookie']);
    expect(next.status).toBe(401);
  });

  it('stores only one-way token digests, including during rotation grace', async () => {
    const { user, cookie } = await createTestUser();
    const rawToken = String(cookie).match(/refreshToken=([^;]+)/)?.[1];
    const defaultView = await User.findById(user.id).lean();
    expect(defaultView.password).toBeUndefined();
    expect(defaultView.refreshTokens).toBeUndefined();

    const persisted = await User.findById(user.id).select('+password +refreshTokens').lean();
    const session = await AuthSession.findOne({ userId: user.id })
      .select('+currentTokenHash')
      .lean();

    expect(rawToken).toBeDefined();
    expect(persisted.password).toMatch(/^\$2[aby]\$/);
    expect(persisted.refreshTokens).toHaveLength(0);
    expect(session.currentTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.currentTokenHash).not.toBe(rawToken);

    const rotated = await request.post('/api/auth/refresh').set('Cookie', cookie);
    const rotatedRawToken = String(rotated.headers['set-cookie'])
      .match(/refreshToken=([^;]+)/)?.[1];
    const rotatedSession = await AuthSession.findOne({ userId: user.id })
      .select('+currentTokenHash +previousTokenHash +graceTokenId +graceTokenIssuedAt')
      .lean();
    expect(rotatedSession.currentTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedSession.previousTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedSession.graceTokenId).toBeTruthy();
    expect(JSON.stringify(rotatedSession)).not.toContain(rawToken);
    expect(JSON.stringify(rotatedSession)).not.toContain(rotatedRawToken);
  });

  it('keeps independent device families valid when one device logs out', async () => {
    const owner = await createTestUser();
    const secondLogin = await request.post('/api/auth/login').send({
      email: owner.user.email,
      password: 'password123',
    });
    const secondCookie = secondLogin.headers['set-cookie'];
    expect(await AuthSession.countDocuments({
      userId: owner.user.id,
      revokedAt: null,
    })).toBe(2);

    await request.post('/api/auth/logout').set('Cookie', owner.cookie);
    const firstRefresh = await request.post('/api/auth/refresh').set('Cookie', owner.cookie);
    const secondRefresh = await request.post('/api/auth/refresh').set('Cookie', secondCookie);
    expect(firstRefresh.status).toBe(401);
    expect(secondRefresh.status).toBe(200);
  });
});

describe('Rate limiter CORS ordering', () => {
  // Limiters are off in tests (RATE_LIMITS_ENABLED=false); tests/integration/rateLimits.test.js proves the 429 carries CORS.
  it('applies CORS before the global rate limiter so 429 responses carry CORS headers', () => {
    // The limiter skips itself under NODE_ENV=test, so ordering is asserted
    // structurally: a 429 short-circuits the stack, and only middleware mounted
    // before the limiter gets to set Access-Control-Allow-Origin on it.
    const stack = app.router.stack;
    const corsIndex = stack.findIndex((layer) => layer.handle.name === 'corsMiddleware');
    const limiterIndex = stack.findIndex((layer) => layer.handle === globalLimiter);

    expect(corsIndex).toBeGreaterThan(-1);
    expect(limiterIndex).toBeGreaterThan(-1);
    expect(corsIndex).toBeLessThan(limiterIndex);
  });
});

describe('Browser request origin protection', () => {
  it('rejects a cross-site login POST in production', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousClientUrl = process.env.CLIENT_URL;
    const previousOriginChecks = process.env.ORIGIN_CHECKS_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.CLIENT_URL = 'https://portal.yourguava.example';
    // The test env switches origin checks off (tests/env.js); production runs with them on.
    process.env.ORIGIN_CHECKS_ENABLED = 'true';
    try {
      const res = await request
        .post('/api/auth/login')
        .set('Origin', 'https://attacker.example')
        .send({ email: 'victim@example.com', password: 'password123' });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/origin/i);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousClientUrl === undefined) delete process.env.CLIENT_URL;
      else process.env.CLIENT_URL = previousClientUrl;
      if (previousOriginChecks === undefined) delete process.env.ORIGIN_CHECKS_ENABLED;
      else process.env.ORIGIN_CHECKS_ENABLED = previousOriginChecks;
    }
  });
});

describe('Profile RBAC', () => {
  it('blocks managers from changing organization details', async () => {
    const owner = await createTestUser();
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

    const res = await request
      .patch('/api/account/profile')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ organizationName: 'Hijacked Org', billingEmail: 'evil@example.com' });

    expect(res.status).toBe(403);
    const org = await Organization.findById(owner.user.orgId);
    expect(org.name).not.toBe('Hijacked Org');
  });

  it('still allows managers to update their own name', async () => {
    const owner = await createTestUser();
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

    const res = await request
      .patch('/api/account/profile')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'Renamed Manager' });

    expect(res.status).toBe(200);
    const persisted = await User.findById(manager.user.id);
    expect(persisted.name).toBe('Renamed Manager');
  });
});

describe('Cross-tenant staff scoping', () => {
  it('rejects shifts referencing another cafe\'s staff', async () => {
    const owner = await createTestUser();
    const otherCafe = await Cafe.create({ name: 'Other Cafe', orgId: owner.user.orgId });
    const foreignStaff = await Staff.create({
      cafeId: otherCafe._id,
      name: 'Foreign Staff',
      role: 'barista',
      hourlyRate: 50,
    });

    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        staffId: foreignStaff._id.toString(),
        date: '2026-06-15',
        startTime: '08:00',
        endTime: '16:00',
      });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Staff member not found');
  });

  it('rejects leave requests referencing another cafe\'s staff', async () => {
    const owner = await createTestUser();
    const otherCafe = await Cafe.create({ name: 'Other Cafe', orgId: owner.user.orgId });
    const foreignStaff = await Staff.create({
      cafeId: otherCafe._id,
      name: 'Foreign Staff',
      role: 'barista',
      hourlyRate: 50,
    });

    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        staffId: foreignStaff._id.toString(),
        type: 'annual',
        startDate: '2026-06-15',
        endDate: '2026-06-16',
      });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Staff member not found');
  });
});
