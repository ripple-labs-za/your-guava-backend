const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const PasswordResetToken = require('../../src/models/PasswordResetToken.model');
const { sha256Hex } = require('../../src/utils/authPrimitives');
const { settleAfterResponse } = require('../../src/utils/afterResponse');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  await settleAfterResponse();
  jest.restoreAllMocks();
  await clearDB();
});

const sentTokens = () => {
  const tokens = [];
  jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async ({ resetToken }) => {
    tokens.push(resetToken);
    return { sent: true };
  });
  return tokens;
};

// UAT-01-S05: three forgot-password requests a moment apart left three pending reset tokens. The delivery runs after
// the response, so the requests' revoke-then-create steps interleaved and each revoked the others before they existed.
describe('only the newest password reset link stays live', () => {
  it('invalidates the previous link even when another process generates a lower ObjectId', async () => {
    const userId = (await createTestUser({ email: 'unordered@yourguava.com' })).user.id;
    const tokens = sentTokens();
    const create = PasswordResetToken.create.bind(PasswordResetToken);
    const ids = ['ffffffffffffffffffffffff', '000000000000000000000001'];
    jest.spyOn(PasswordResetToken, 'create').mockImplementation((data, options) => {
      const _id = new mongoose.Types.ObjectId(ids.shift());
      return create(Array.isArray(data) ? [{ ...data[0], _id }] : { ...data, _id }, options);
    });

    for (let i = 0; i < 2; i += 1) {
      await request.post('/api/auth/forgot-password').send({ email: 'unordered@yourguava.com' });
      await settleAfterResponse();
    }

    expect(tokens).toHaveLength(2);
    const pending = await PasswordResetToken.find({ userId, status: 'pending' }).select('+tokenHash').lean();
    expect(pending).toHaveLength(1);
    expect(pending[0].tokenHash).toBe(sha256Hex(tokens[1]));
    const old = await request.post('/api/auth/reset-password').send({ token: tokens[0], password: 'newPassword123' });
    expect(old.status).toBe(404);
    const current = await request.post('/api/auth/reset-password').send({ token: tokens[1], password: 'newPassword123' });
    expect(current.status).toBe(200);
  });

  it('leaves exactly one pending token when requests arrive together', async () => {
    const userId = (await createTestUser({ email: 'race@yourguava.com' })).user.id;
    const tokens = sentTokens();

    await Promise.all([1, 2, 3].map(() => request.post('/api/auth/forgot-password').send({ email: 'race@yourguava.com' })));
    await settleAfterResponse();

    expect(tokens).toHaveLength(3);
    const pending = await PasswordResetToken.find({ userId, status: 'pending' }).lean();
    expect(pending).toHaveLength(1);
    const current = await PasswordResetToken.findById(pending[0]._id).select('+tokenHash').lean();
    expect(tokens.map(sha256Hex)).toContain(current.tokenHash);
  });

  it('keeps one pending token across ordinary one-after-another requests', async () => {
    const userId = (await createTestUser({ email: 'serial@yourguava.com' })).user.id;
    sentTokens();

    for (let i = 0; i < 3; i += 1) {
      await request.post('/api/auth/forgot-password').send({ email: 'serial@yourguava.com' });
      await settleAfterResponse();
    }

    expect(await PasswordResetToken.countDocuments({ userId, status: 'pending' })).toBe(1);
    expect(await PasswordResetToken.countDocuments({ userId, status: 'revoked' })).toBe(2);
  });

  it('keeps the previous link live if replacement creation fails', async () => {
    const userId = (await createTestUser({ email: 'rollback@yourguava.com' })).user.id;
    const tokens = sentTokens();
    await request.post('/api/auth/forgot-password').send({ email: 'rollback@yourguava.com' });
    await settleAfterResponse();
    jest.spyOn(PasswordResetToken, 'create').mockRejectedValueOnce(new Error('replacement failed'));

    await request.post('/api/auth/forgot-password').send({ email: 'rollback@yourguava.com' });
    await settleAfterResponse();

    expect(tokens).toHaveLength(1);
    const pending = await PasswordResetToken.find({ userId, status: 'pending' }).select('+tokenHash').lean();
    expect(pending).toHaveLength(1);
    expect(pending[0].tokenHash).toBe(sha256Hex(tokens[0]));
  });

  it('does not revoke another user link and revokes a replacement whose email fails', async () => {
    const first = await createTestUser({ email: 'first-reset@yourguava.com' });
    const other = await createTestUser({ email: 'other-reset@yourguava.com' });
    sentTokens();
    for (const email of ['first-reset@yourguava.com', 'other-reset@yourguava.com']) {
      await request.post('/api/auth/forgot-password').send({ email });
      await settleAfterResponse();
    }
    emailService.sendPasswordResetEmail.mockResolvedValueOnce({ sent: false, reason: 'test failure' });
    await request.post('/api/auth/forgot-password').send({ email: 'first-reset@yourguava.com' });
    await settleAfterResponse();

    expect(await PasswordResetToken.countDocuments({ userId: first.user.id, status: 'pending' })).toBe(0);
    expect(await PasswordResetToken.countDocuments({ userId: first.user.id, status: 'revoked' })).toBe(2);
    expect(await PasswordResetToken.countDocuments({ userId: other.user.id, status: 'pending' })).toBe(1);
  });
});
