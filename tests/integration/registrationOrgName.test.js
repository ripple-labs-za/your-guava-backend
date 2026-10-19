const supertest = require('supertest');
const { setup, teardown, clearDB, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const User = require('../../src/models/User.model');
const Organization = require('../../src/models/Organization.model');
const Cafe = require('../../src/models/Cafe.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const captureToken = () => {
  const tokens = [];
  jest.spyOn(emailService, 'sendVerificationEmail').mockImplementation(async ({ verificationToken }) => {
    tokens.push(verificationToken);
    return { sent: true };
  });
  return tokens;
};

const signUp = async (body) => {
  const tokens = captureToken();
  const registered = await request.post('/api/auth/register').send(body);
  expect(registered.status).toBe(202);
  const verified = await request.post('/api/auth/verify-email').send({ token: tokens.at(-1), password: body.password });
  expect(verified.status).toBe(201);
  const user = await User.findOne({ email: body.email.toLowerCase() }).lean();
  return { user, org: await Organization.findById(user.orgId).lean() };
};

// UAT-01-S01: the signup page says "Leave this blank and we'll use your cafe name.", but a blank business name
// produced "<name>'s Organization".
describe('the organisation a signup creates', () => {
  it('is named after the cafe when the business name is left blank, as the signup page promises', async () => {
    const { user, org } = await signUp({ name: 'Thandi Owner', email: 'Thandi@Cafe.co.za', password: 'thandi-password-1', cafeName: 'Corner Roastery' });

    expect(org.name).toBe('Corner Roastery');
    // Nothing else about the signup changes.
    expect(user).toEqual(expect.objectContaining({ email: 'thandi@cafe.co.za', name: 'Thandi Owner', role: 'owner', emailVerified: true }));
    const cafes = await Cafe.find({ orgId: org._id }).lean();
    expect(cafes.map((cafe) => cafe.name)).toEqual(['Corner Roastery']);
  });

  it('treats a whitespace-only business name as blank', async () => {
    const { org } = await signUp({ name: 'Sipho Owner', email: 'sipho@cafe.co.za', password: 'sipho-password-1', cafeName: 'Harbour Cafe', orgName: '   ' });
    expect(org.name).toBe('Harbour Cafe');
  });

  it('keeps a business name the owner did give', async () => {
    const { org } = await signUp({ name: 'Lerato Owner', email: 'lerato@cafe.co.za', password: 'lerato-password-1', cafeName: 'Main Street Cafe', orgName: 'Lerato Group' });
    expect(org.name).toBe('Lerato Group');
  });

  it("falls back to the owner's name only when no cafe name was sent either", async () => {
    const { org } = await signUp({ name: 'Api Caller', email: 'api@cafe.co.za', password: 'api-caller-pass-1' });
    expect(org.name).toBe("Api Caller's Organization");
  });
});
