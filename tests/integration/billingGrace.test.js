const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Organization = require('../../src/models/Organization.model');

const request = supertest(app);
const { billingAccessForOrganization, billingGraceDays } = require('../../src/services/usage.service');
const DAY = 24 * 60 * 60 * 1000;

describe('grace policy boundaries', () => {
  it.each([['-1', 0], ['abc', 3], ['9999', 14], ['', 3]])('bounds %s to %s days', (value, days) => {
    process.env.BILLING_GRACE_DAYS = value;
    expect(billingGraceDays()).toBe(days);
    const now = new Date('2026-10-18T12:00:00.000Z');
    const access = billingAccessForOrganization({ billingStatus: 'past_due', currentPeriodEnd: new Date(now - DAY) }, now);
    expect(access.readOnly).toBe(days > 0);
    if (days > 0) expect(access.graceEndsAt.getTime()).toBe(now.getTime() + (days - 1) * DAY);
  });

  it('does not grant grace before an inferred trial end on a past-due record with no paid dates', () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    expect(billingAccessForOrganization({ billingStatus: 'past_due', createdAt: now }, now).readOnly).toBe(false);
  });

  it('grants grace to a past-due paid record but never to a canceled one', () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    const org = { currentPeriodEnd: new Date(now - 2 * DAY) };
    expect(billingAccessForOrganization({ ...org, billingStatus: 'past_due' }, now).readOnly).toBe(true);
    expect(billingAccessForOrganization({ ...org, billingStatus: 'canceled' }, now).readOnly).toBe(false);
  });
});

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  delete process.env.BILLING_GRACE_DAYS;
  await clearDB();
});

const endedPaidPeriod = (orgId, msAgo) => Organization.updateOne({ _id: orgId }, {
  $set: {
    plan: 'growth',
    billingStatus: 'active',
    billingCycle: 'monthly',
    currentPeriodStart: new Date(Date.now() - msAgo - 30 * DAY),
    currentPeriodEnd: new Date(Date.now() - msAgo),
  },
});
const get = (path, token) => request.get(path).set('Authorization', `Bearer ${token}`);

describe('read-only grace period after a lapse (gap-3)', () => {
  it.each(['/api/integrations/yoco/auth', '/api/Integrations/Yoco/Auth/', '/api/YOCO/AUTH'])('blocks OAuth connection GET %s during grace', async (path) => {
    const owner = await createTestUser();
    await endedPaidPeriod(owner.user.orgId, DAY);
    const result = await get(path, owner.token);
    expect(result.status).toBe(402);
    expect(result.body.billing).toEqual(expect.objectContaining({ status: 'grace', readOnly: true }));
  });

  it('a lapsed paid org can read, but not write, for the grace period', async () => {
    const owner = await createTestUser();
    await endedPaidPeriod(owner.user.orgId, 1 * DAY);
    const { currentPeriodEnd } = await Organization.findById(owner.user.orgId).lean();

    const read = await get('/api/cafe/me', owner.token);
    const write = await request
      .put('/api/cafe/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Renamed During Grace' });

    expect(read.status).toBe(200);
    expect(write.status).toBe(402);
    expect(write.body.code).toBe('BILLING_REQUIRED');
    expect(write.body.message).toMatch(/read-only until/i);
    expect(write.body.billing).toEqual(expect.objectContaining({ status: 'grace', readOnly: true }));
    expect(new Date(write.body.billing.graceEndsAt).getTime()).toBe(currentPeriodEnd.getTime() + 3 * DAY);
  });

  it('a lapsed trial gets the same grace', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { billingStatus: 'trialing', trialEndsAt: new Date(Date.now() - DAY) } }
    );

    expect((await get('/api/cafe/me', owner.token)).status).toBe(200);
  });

  it('switching cafe still works during grace, because it only reads another cafe', async () => {
    const owner = await createTestUser();
    await endedPaidPeriod(owner.user.orgId, 1 * DAY);

    const res = await request
      .post('/api/team/switch-cafe')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ cafeId: owner.user.activeCafeId });

    expect(res.status).toBe(200);
  });

  it('after the grace period only account and auth answer', async () => {
    const owner = await createTestUser();
    await endedPaidPeriod(owner.user.orgId, 4 * DAY);

    const blocked = await get('/api/cafe/me', owner.token);
    const account = await get('/api/account', owner.token);

    expect(blocked.status).toBe(402);
    expect(blocked.body.billing).toEqual(expect.objectContaining({ status: 'past_due', readOnly: false, graceEndsAt: null }));
    expect(account.status).toBe(200);
    expect(account.body.account.organization.billingAccess.status).toBe('past_due');
  });

  it('BILLING_GRACE_DAYS=0 restores the immediate lockout', async () => {
    process.env.BILLING_GRACE_DAYS = '0';
    const owner = await createTestUser();
    await endedPaidPeriod(owner.user.orgId, 60_000);

    expect((await get('/api/cafe/me', owner.token)).status).toBe(402);
  });

  it('keeps metered features off during grace and tells the account page why', async () => {
    const owner = await createTestUser();
    await endedPaidPeriod(owner.user.orgId, 1 * DAY);

    const res = await get('/api/account', owner.token);

    expect(res.body.account.organization.billingAccess).toEqual(expect.objectContaining({
      allowed: false, status: 'grace', readOnly: true, graceEndsAt: expect.any(String),
    }));
    expect(res.body.account.usage.guavaCredits.available).toBe(0);
  });
});

describe('the lapse write never overwrites a renewal (billing-14)', () => {
  it('leaves an org active when a renewal lands between the billing read and the past_due write', async () => {
    const owner = await createTestUser();
    const renewedEnd = new Date(Date.now() + 30 * DAY);
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { plan: 'growth', billingStatus: 'active', billingCycle: 'monthly', currentPeriodEnd: renewedEnd } }
    );
    const renewed = await Organization.findById(owner.user.orgId).lean();
    // What a concurrent request read a moment before the payment moved the period end forward.
    const staleSnapshot = { ...renewed, currentPeriodEnd: new Date(Date.now() - 60_000) };
    jest.spyOn(Organization, 'findById').mockImplementationOnce(() => ({ lean: async () => staleSnapshot }));

    await get('/api/cafe/me', owner.token);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.billingStatus).toBe('active');
    expect(org.currentPeriodEnd).toEqual(renewedEnd);
  });
});
