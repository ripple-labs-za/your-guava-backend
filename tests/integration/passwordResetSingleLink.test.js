const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const PasswordResetToken = require('../../src/models/PasswordResetToken.model');
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
  it('leaves exactly one pending token when requests arrive together', async () => {
    const userId = (await createTestUser({ email: 'race@yourguava.com' })).user.id;
    const tokens = sentTokens();

    await Promise.all([1, 2, 3].map(() => request.post('/api/auth/forgot-password').send({ email: 'race@yourguava.com' })));
    await settleAfterResponse();

    expect(tokens).toHaveLength(3);
    const pending = await PasswordResetToken.find({ userId, status: 'pending' }).lean();
    expect(pending).toHaveLength(1);
    const newest = await PasswordResetToken.findOne({ userId }).sort({ _id: -1 }).lean();
    expect(String(pending[0]._id)).toBe(String(newest._id));
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
});
