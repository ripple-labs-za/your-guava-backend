const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');
const User = require('../../src/models/User.model');
const { seed } = require('../../src/seed');

const request = supertest(app);
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
beforeAll(setup);
afterAll(teardown);
beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

describe('local seed script', () => {
  it('creates the demo owner, organisation and cafe, imports the file through ingestion, and the owner can log in', async () => {
    const result = await seed({ mongoUri: process.env.MONGODB_URI, importFile: FIXTURE, manageConnection: false });

    const owner = await User.findOne({ email: 'demo@yourguava.local' }).lean();
    expect(owner).toEqual(expect.objectContaining({ role: 'owner' }));
    expect(String(owner.orgId)).toBe(String(result.orgId));
    const cafe = await Cafe.findById(result.cafeId).lean();
    expect(cafe).toEqual(expect.objectContaining({ dataUploaded: true, timezone: 'Africa/Johannesburg' }));
    expect(await Transaction.countDocuments({ cafeId: result.cafeId })).toBe(result.stats.imported);
    expect(result.stats.imported).toBeGreaterThan(0);

    const login = await request.post('/api/auth/login').send({ email: 'demo@yourguava.local', password: 'password123' });
    expect(login.status).toBe(200);
  });

  it('refuses a database that is not a single loopback host, before touching anything', async () => {
    // A user already present must survive: the seed's own reset would delete it, so an empty count alone proves nothing.
    const existing = await createTestUser();
    await expect(seed({ mongoUri: 'mongodb://db.example.com:27017/guava', importFile: FIXTURE, manageConnection: false }))
      .rejects.toThrow(/loopback/);
    expect((await User.find({}).lean()).map((user) => String(user._id))).toEqual([String(existing.user.id)]);
    expect(await User.countDocuments({ email: 'demo@yourguava.local' })).toBe(0);
  });

  it('refuses a missing import file and a short password with the same messages the CLI prints', async () => {
    const base = { mongoUri: process.env.MONGODB_URI, manageConnection: false };
    await expect(seed({ ...base, importFile: 'no-such-file.csv' })).rejects.toThrow(/Import file does not exist/);
    await expect(seed({ ...base, importFile: FIXTURE, userPassword: 'short' })).rejects.toThrow(/at least 8 characters/);
  });
});
