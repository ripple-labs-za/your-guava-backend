const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const { ERROR_CODES } = require('../../src/utils/errorCodes');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

// FB-043 (UAT-09-S11, reviewer-b90-3): a wrong current password and an expired session are both 401s. The portal
// must refresh the second and never the first, so the wrong password says so in a registered code.
describe('a wrong current password carries CURRENT_PASSWORD_INCORRECT', () => {
  it('is a registered client code', () => {
    expect(ERROR_CODES.CURRENT_PASSWORD_INCORRECT).toEqual(expect.objectContaining({ status: 401, client: true }));
  });

  const someone = () => String(new mongoose.Types.ObjectId());

  it('on ownership transfer, for a wrong and for an over-long password', async () => {
    const owner = await createTestUser({ email: 'transfer-code@yourguava.com' });
    for (const currentPassword of ['not-my-password', 'x'.repeat(80)]) {
      const res = await request.post('/api/team/transfer-ownership')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ userId: someone(), currentPassword });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(expect.objectContaining({ code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' }));
    }
  });

  it('on change-password, for a wrong and for an over-long password', async () => {
    const owner = await createTestUser({ email: 'change-code@yourguava.com' });
    for (const currentPassword of ['not-my-password', 'x'.repeat(80)]) {
      const res = await request.post('/api/auth/change-password')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ currentPassword, newPassword: 'a-new-password-1' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual(expect.objectContaining({ code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' }));
    }
  });

  it('is not on the 401 an expired or missing session gets', async () => {
    const res = await request.post('/api/team/transfer-ownership').send({ userId: someone(), currentPassword: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.code).not.toBe('CURRENT_PASSWORD_INCORRECT');
  });
});
