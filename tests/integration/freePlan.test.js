const mongoose = require('mongoose');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

describe('organisations stored on the legacy free plan (gap-7)', () => {
  it('get Starter factors: weather can be changed, not refused as a locked tier', async () => {
    const owner = await createTestUser();
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { plan: 'free' } });

    const factors = await request.get('/api/forecasts/factors').set('Authorization', `Bearer ${owner.token}`);
    const update = await request
      .put('/api/forecasts/factors')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ settings: { weather: { hotTemp: 28 } } });

    expect(factors.status).toBe(200);
    expect(factors.body.entitlements.plan).toBe('starter');
    expect(factors.body.entitlements.unlockedKeys).toEqual(expect.arrayContaining(['weather', 'holiday']));
    expect(update.status).toBe(200);
  });

  it('are rewritten to starter by the migration, once', async () => {
    const { up } = require('../../src/migrations/free-plan-to-starter');
    const owner = await createTestUser();
    await Organization.updateOne({ _id: owner.user.orgId }, { $set: { plan: 'free' } });

    const first = await up(mongoose.connection.db);
    const second = await up(mongoose.connection.db);

    expect(first).toEqual({ matched: 1, modified: 1 });
    expect(second).toEqual({ matched: 0, modified: 0 });
    expect((await Organization.findById(owner.user.orgId).lean()).plan).toBe('starter');
  });

  it('leaves every current paid plan unchanged', async () => {
    const { up } = require('../../src/migrations/free-plan-to-starter');
    const owner = await createTestUser();
    for (const plan of ['starter', 'growth', 'pro']) {
      await Organization.updateOne({ _id: owner.user.orgId }, { $set: { plan } });
      expect(await up(mongoose.connection.db)).toEqual({ matched: 0, modified: 0 });
      expect((await Organization.findById(owner.user.orgId).lean()).plan).toBe(plan);
    }
  });
});
