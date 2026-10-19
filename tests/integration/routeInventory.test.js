const supertest = require('supertest');
const mongoose = require('mongoose');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('route inventory (BE-13-T01)', () => {
  it('has one member-update route: PUT /api/team/:userId/cafes is gone and PATCH /api/team/:userId remains', async () => {
    const { token } = await createTestUser();
    const someone = new mongoose.Types.ObjectId().toString();

    const alias = await request
      .put(`/api/team/${someone}/cafes`)
      .set('Authorization', `Bearer ${token}`)
      .send({ cafeIds: [] });
    expect(alias.status).toBe(404);
    expect(alias.body.message).toBe('Route not found');

    const patch = await request
      .patch(`/api/team/${someone}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nobody Here' });
    expect(patch.body.message).not.toBe('Route not found');
    expect([400, 403, 404]).toContain(patch.status);
  });
});
