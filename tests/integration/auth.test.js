const logger = require('../../src/utils/logger');
const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  app,
} = require('../setup');
const emailService = require('../../src/services/email.service');
const User = require('../../src/models/User.model');
const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const PendingRegistration = require('../../src/models/PendingRegistration.model');
const PasswordResetToken = require('../../src/models/PasswordResetToken.model');
const { settleAfterResponse } = require('../../src/utils/afterResponse');
const AuthSession = require('../../src/models/AuthSession.model');
const AccessAuditEvent = require('../../src/models/AccessAuditEvent.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const registrationPayload = (overrides = {}) => ({
  name: 'Test Owner',
  email: 'test@yourguava.com',
  password: 'password123',
  cafeName: 'Test Cafe',
  orgName: 'Test Org',
  ...overrides,
});

const submitRegistration = async (overrides = {}) => {
  let verificationToken;
  const verificationSpy = jest
    .spyOn(emailService, 'sendVerificationEmail')
    .mockImplementation(async ({ verificationToken: token }) => {
      verificationToken = token;
      return { sent: true };
    });
  const response = await request
    .post('/api/auth/register')
    .send(registrationPayload(overrides));
  return { response, verificationToken, verificationSpy };
};

describe('Auth API', () => {
  describe('email-verified owner registration', () => {
    it('declares TTL cleanup for every sensitive temporary auth record', () => {
      for (const model of [PendingRegistration, PasswordResetToken, AuthSession]) {
        expect(model.schema.indexes()).toEqual(expect.arrayContaining([
          [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
        ]));
      }
    });

    it('keeps credentials pending until the single-use verification link is consumed', async () => {
      const welcomeSpy = jest
        .spyOn(emailService, 'sendWelcomeEmail')
        .mockResolvedValue({ sent: true });
      const { response, verificationToken } = await submitRegistration();

      expect(response.status).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        success: true,
        verificationRequired: true,
        email: 'test@yourguava.com',
      }));
      expect(response.body.accessToken).toBeUndefined();
      expect(response.body.user).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain(verificationToken);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await User.countDocuments()).toBe(0);
      expect(await Organization.countDocuments()).toBe(0);
      expect(await Cafe.countDocuments()).toBe(0);

      const pending = await PendingRegistration.findOne({
        email: 'test@yourguava.com',
      }).select('+passwordHash +tokenHash');
      expect(pending.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(pending.passwordHash).not.toBe('password123');
      expect(pending.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(pending.tokenHash).not.toBe(verificationToken);

      const verified = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken, password: 'password123' });
      expect(verified.status).toBe(201);
      expect(verified.headers['cache-control']).toBe('no-store');
      expect(verified.body.accessToken).toBeUndefined();
      expect(await PendingRegistration.countDocuments()).toBe(0);

      const user = await User.findOne({ email: 'test@yourguava.com' }).lean();
      const org = await Organization.findById(user.orgId).lean();
      const cafe = await Cafe.findById(user.activeCafeId).lean();
      expect(user).toEqual(expect.objectContaining({
        name: 'Test Owner',
        role: 'owner',
        emailVerified: true,
      }));
      expect(org.name).toBe('Test Org');
      expect(String(org.ownerId)).toBe(String(user._id));
      expect(cafe.name).toBe('Test Cafe');
      expect(welcomeSpy).toHaveBeenCalledWith({
        user: expect.objectContaining({ email: 'test@yourguava.com' }),
        org: expect.objectContaining({ name: 'Test Org' }),
        cafe: expect.objectContaining({ name: 'Test Cafe' }),
      });

      const replay = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken, password: 'password123' });
      expect(replay.status).toBe(404);

      const login = await request.post('/api/auth/login').send({
        email: 'test@yourguava.com',
        password: 'password123',
      });
      expect(login.status).toBe(200);
      expect(login.body.accessToken).toBeDefined();
      expect(login.body.user.permissions).toEqual({ canSpendCredits: true });
    });

    it('retains the pending registration when verification delivery fails', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
      jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({
        skipped: true,
        reason: 'resend_not_configured',
      });
      const response = await request
        .post('/api/auth/register')
        .send(registrationPayload({ email: 'delivery@yourguava.com' }));

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('VERIFICATION_EMAIL_FAILED');
      expect(await PendingRegistration.countDocuments({
        email: 'delivery@yourguava.com',
      })).toBe(1);
      expect(await User.countDocuments({ email: 'delivery@yourguava.com' })).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('verification_email_failed', expect.objectContaining({ reason: 'resend_not_configured' }));
    });

    it('rotates verification links on resend without revealing account existence', async () => {
      const initial = await submitRegistration({ email: 'resend@yourguava.com' });
      initial.verificationSpy.mockRestore();

      let replacementToken;
      jest
        .spyOn(emailService, 'sendVerificationEmail')
        .mockImplementation(async ({ verificationToken }) => {
          replacementToken = verificationToken;
          return { sent: true };
        });
      const resent = await request
        .post('/api/auth/resend-verification')
        .send({ email: 'resend@yourguava.com' });
      const unknown = await request
        .post('/api/auth/resend-verification')
        .send({ email: 'unknown@yourguava.com' });
      await settleAfterResponse();
      expect(resent.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(unknown.body.message).toBe(resent.body.message);
      expect(JSON.stringify(resent.body)).not.toContain(replacementToken);

      const stale = await request
        .post('/api/auth/verify-email')
        .send({ token: initial.verificationToken, password: 'password123' });
      expect(stale.status).toBe(404);
      const accepted = await request
        .post('/api/auth/verify-email')
        .send({ token: replacementToken, password: 'password123' });
      expect(accepted.status).toBe(201);
    });

    it('still completes verification when the non-critical welcome email fails', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      jest
        .spyOn(emailService, 'sendWelcomeEmail')
        .mockRejectedValue(new Error('resend unavailable'));
      const { verificationToken } = await submitRegistration({
        email: 'welcome-failure@yourguava.com',
      });
      const verified = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken, password: 'password123' });
      expect(verified.status).toBe(201);
      expect(warnSpy).toHaveBeenCalledWith(
        'welcome_email_failed', expect.objectContaining({ errorMessage: 'resend unavailable' })
      );
    });

    it('validates required fields, password length, and tenant names', async () => {
      const missing = await request
        .post('/api/auth/register')
        .send({ email: 'missing@yourguava.com' });
      expect(missing.status).toBe(400);

      const short = await request.post('/api/auth/register').send(
        registrationPayload({
          email: 'short@yourguava.com',
          password: 'short7',
        })
      );
      expect(short.status).toBe(400);
      expect(short.body.message).toMatch(/at least 8/i);

      const oversized = await request.post('/api/auth/register').send(
        registrationPayload({
          email: 'oversized@yourguava.com',
          cafeName: 'x'.repeat(121),
        })
      );
      expect(oversized.status).toBe(400);
      expect(oversized.body.message).toMatch(/cafe name/i);
    });
  });

  describe('a hostile email does not freeze the server', () => {
    // "a@" + 99,000 dots + "@" fits the 100 KB JSON limit. The pattern these
    // handlers used split the domain at every dot and took about 8 s per
    // request, blocking the event loop for every cafe; login needs no account.
    const hostile = `a@${'.'.repeat(99_000)}@`;

    it.each([
      ['/api/auth/login', { password: 'password123' }, 401],
      ['/api/auth/register', { name: 'Test Owner', password: 'password123', cafeName: 'Test Cafe' }, 400],
      ['/api/auth/resend-verification', {}, 200],
      ['/api/auth/forgot-password', {}, 200],
    ])('%s answers at once', async (path, body, status) => {
      const started = Date.now();
      const response = await request.post(path).send({ ...body, email: hostile });
      const elapsedMs = Date.now() - started;

      expect(response.status).toBe(status);
      expect(elapsedMs).toBeLessThan(1000);
    });

    it('a team invite answers at once', async () => {
      const owner = await createTestUser({ name: 'Invite Owner', email: 'invite-owner@yourguava.com' });
      const started = Date.now();
      const response = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ email: hostile, name: 'New Manager', cafeIds: [owner.user.activeCafeId] });
      const elapsedMs = Date.now() - started;

      expect(response.status).toBe(400);
      expect(elapsedMs).toBeLessThan(1000);
    });

    it('login answers a 100 KB email with 401 in under 50 ms (median of 5)', async () => {
      // One warm-up call so connection set-up and JIT are not in the sample.
      await request.post('/api/auth/login').send({ email: 'warm@up.co', password: 'password123' });
      const samples = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const started = process.hrtime.bigint();
        const response = await request.post('/api/auth/login').send({ email: hostile, password: 'password123' });
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        expect(response.status).toBe(401);
        expect(response.body.message).toBe('Invalid credentials');
      }
      const median = [...samples].sort((a, b) => a - b)[2];
      console.log(`login 100 KB email: median ${median.toFixed(1)} ms, all ${samples.map((ms) => ms.toFixed(1)).join(', ')}`);
      expect(median).toBeLessThan(50);
      expect(Math.max(...samples)).toBeLessThan(250);
    });

    it('a billing-email change answers a 100 KB address at once', async () => {
      const owner = await createTestUser({ name: 'Billing Owner', email: 'billing-owner@yourguava.com' });
      const started = process.hrtime.bigint();
      const response = await request
        .patch('/api/account/profile')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ billingEmail: hostile });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Enter a valid billing email address');
      expect(ms).toBeLessThan(250);
    });
  });

  describe('login, profile, and logout', () => {
    it('logs in with valid credentials and rejects invalid credentials', async () => {
      await createTestUser({
        name: 'Login User',
        email: 'login@yourguava.com',
        cafeName: 'Login Cafe',
      });
      const valid = await request.post('/api/auth/login').send({
        email: 'login@yourguava.com',
        password: 'password123',
      });
      const wrong = await request.post('/api/auth/login').send({
        email: 'login@yourguava.com',
        password: 'wrongpassword',
      });
      const missing = await request.post('/api/auth/login').send({
        email: 'doesnotexist@yourguava.com',
        password: 'password123',
      });
      expect(valid.status).toBe(200);
      expect(valid.body.accessToken).toBeDefined();
      expect(wrong.status).toBe(401);
      expect(missing.status).toBe(401);
    });

    it('returns the live profile for a valid token', async () => {
      const testUser = await createTestUser({
        name: 'Me User',
        email: 'me@yourguava.com',
      });
      const response = await request
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${testUser.token}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        email: 'me@yourguava.com',
        name: 'Me User',
        emailVerified: true,
        permissions: { canSpendCredits: true },
      }));
      expect((await request.get('/api/auth/me')).status).toBe(401);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', 'Bearer invalid-token-here')
        ).status
      ).toBe(401);
    });

    it('revokes the refresh family on cookie-only logout', async () => {
      const testUser = await createTestUser({ email: 'logout@yourguava.com' });
      const response = await request
        .post('/api/auth/logout')
        .set('Cookie', testUser.cookie);
      expect(response.status).toBe(200);
      expect(String(response.headers['set-cookie'])).toContain('refreshToken=');
      const replay = await request
        .post('/api/auth/refresh')
        .set('Cookie', testUser.cookie);
      expect(replay.status).toBe(401);
    });
  });

  describe('password recovery and changes', () => {
    it('uses a generic forgot-password response and a single-use reset token', async () => {
      const testUser = await createTestUser({ email: 'reset@yourguava.com' });
      let resetToken;
      jest
        .spyOn(emailService, 'sendPasswordResetEmail')
        .mockImplementation(async ({ resetToken: token }) => {
          resetToken = token;
          return { sent: true };
        });

      const known = await request
        .post('/api/auth/forgot-password')
        .send({ email: 'reset@yourguava.com' });
      const unknown = await request
        .post('/api/auth/forgot-password')
        .send({ email: 'unknown@yourguava.com' });
      await settleAfterResponse();
      expect(known.status).toBe(200);
      expect(known.body.message).toBe(unknown.body.message);
      expect(JSON.stringify(known.body)).not.toContain(resetToken);

      const stored = await PasswordResetToken.findOne({
        userId: testUser.user.id,
      }).select('+tokenHash');
      expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.tokenHash).not.toBe(resetToken);

      const reset = await request.post('/api/auth/reset-password').send({
        token: resetToken,
        password: 'newpassword456',
      });
      expect(reset.status).toBe(200);
      expect(reset.headers['cache-control']).toBe('no-store');

      expect(
        (
          await request.post('/api/auth/login').send({
            email: 'reset@yourguava.com',
            password: 'password123',
          })
        ).status
      ).toBe(401);
      expect(
        (
          await request.post('/api/auth/login').send({
            email: 'reset@yourguava.com',
            password: 'newpassword456',
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${testUser.token}`)
        ).status
      ).toBe(401);
      expect(
        (
          await request
            .post('/api/auth/refresh')
            .set('Cookie', testUser.cookie)
        ).status
      ).toBe(401);
      expect(
        (
          await request.post('/api/auth/reset-password').send({
            token: resetToken,
            password: 'another-password-789',
          })
        ).status
      ).toBe(404);
      expect(await AccessAuditEvent.countDocuments({
        action: 'password.reset',
        targetEmail: 'reset@yourguava.com',
      })).toBe(1);
    });

    it('changes a password, revokes existing sessions, and rejects wrong or reused passwords', async () => {
      const testUser = await createTestUser({
        email: 'change@yourguava.com',
      });
      const wrong = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          currentPassword: 'not-the-password',
          newPassword: 'newpassword456',
        });
      expect(wrong.status).toBe(401);

      const reused = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'password123',
        });
      expect(reused.status).toBe(400);

      const changed = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'newpassword456',
        });
      expect(changed.status).toBe(200);
      expect(changed.body.message).toMatch(/sign in again/i);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${testUser.token}`)
        ).status
      ).toBe(401);
      expect(
        (
          await request
            .post('/api/auth/refresh')
            .set('Cookie', testUser.cookie)
        ).status
      ).toBe(401);
      expect(
        (
          await request.post('/api/auth/login').send({
            email: 'change@yourguava.com',
            password: 'newpassword456',
          })
        ).status
      ).toBe(200);
      expect(await AccessAuditEvent.countDocuments({
        action: 'password.changed',
      })).toBe(1);
    });
  });
});
