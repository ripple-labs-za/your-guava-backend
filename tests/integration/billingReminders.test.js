const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Organization = require('../../src/models/Organization.model');
const emailService = require('../../src/services/email.service');
const { runBillingReminders } = require('../../src/services/billing/reminders');

const DAY = 24 * 60 * 60 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const setOrg = (orgId, fields) => Organization.updateOne({ _id: orgId }, { $set: fields });
const sends = (spy) => spy.mock.calls.map(([args]) => ({ to: args.to, kind: args.kind, daysLeft: args.daysLeft }));
const paidUntil = (orgId, ms, extra = {}) => setOrg(orgId, {
  plan: 'growth', billingStatus: 'active', billingCycle: 'monthly', currentPeriodEnd: new Date(Date.now() + ms), ...extra,
});

describe('period-end reminders (gap-3)', () => {
  it.each(['accounts@cafe', 'a@b.co, other@victim.example'])('excludes invalid legacy billing recipients %s', async (billingEmail) => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 6.5 * DAY);
    const mongoose = require('mongoose');
    const written = await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(owner.user.orgId) }, { $set: { billingEmail } });
    expect(written.matchedCount).toBe(1);
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });
    await runBillingReminders();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ['test@yourguava.com'] }));
  });
  it('two overlapping runs claim and deliver a reminder once', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 6.5 * DAY);
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { sent: true };
    });
    await Promise.all([runBillingReminders(), runBillingReminders()]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('reaches an unsent organisation behind a full batch of already sent reminders', async () => {
    const owner = await createTestUser();
    const end = new Date(Date.now() + 6.5 * DAY);
    const key = `paid:${end.toISOString()}:7d`;
    await paidUntil(owner.user.orgId, 6.5 * DAY, { currentPeriodEnd: end, billingRemindersSent: [key] });
    const base = await Organization.findById(owner.user.orgId).select('+billingRemindersSent').lean();
    const mongoose = require('mongoose');
    await Organization.collection.insertMany(Array.from({ length: 200 }, (_, index) => ({
      ...base, _id: new mongoose.Types.ObjectId(), name: `Reminder batch ${index}`,
      billingRemindersSent: index === 199 ? [] : [key],
    })));
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });

    await runBillingReminders();

    expect(send).toHaveBeenCalledTimes(1);
  });
  it('emails the owner and the billing address 7 days before a paid period ends, once', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 6.5 * DAY, { billingEmail: 'accounts@cafe.example' });
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });

    await runBillingReminders();
    await runBillingReminders();

    expect(sends(send)).toEqual([{ to: ['test@yourguava.com', 'accounts@cafe.example'], kind: 'paid', daysLeft: 7 }]);
  });

  it('sends the 1-day reminder as its own message', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 20 * 60 * 60 * 1000);
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });

    await runBillingReminders();

    expect(sends(send)).toEqual([{ to: ['test@yourguava.com'], kind: 'paid', daysLeft: 1 }]);
  });

  it('reminds a trialling org before its trial ends', async () => {
    const owner = await createTestUser();
    await setOrg(owner.user.orgId, { billingStatus: 'trialing', trialEndsAt: new Date(Date.now() + 6 * DAY) });
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });

    await runBillingReminders();

    expect(sends(send)).toEqual([{ to: ['test@yourguava.com'], kind: 'trial', daysLeft: 7 }]);
  });

  it('does not remind an org whose next term is already paid for', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 3 * DAY, {
      pendingPlanChange: {
        plan: 'starter',
        billingCycle: 'monthly',
        effectiveAt: new Date(Date.now() + 3 * DAY),
        periodEnd: new Date(Date.now() + 33 * DAY),
        reference: 'next-term-paid',
      },
    });
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });

    await runBillingReminders();

    expect(send).not.toHaveBeenCalled();
  });

  it('reminds the paid-through end of a due scheduled term even before the owner next visits', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, -DAY, { pendingPlanChange: {
      plan: 'starter', billingCycle: 'monthly', effectiveAt: new Date(Date.now() - DAY),
      periodEnd: new Date(Date.now() + 6.5 * DAY), reference: 'already-started-paid-term',
    } });
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });
    await runBillingReminders();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].daysLeft).toBe(7);
    expect(send.mock.calls[0][0].planName).toBe('Starter');
  });

  it('retries a reminder whose delivery failed, and records it once', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 6.5 * DAY);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail')
      .mockResolvedValueOnce({ sent: false, error: 'provider down' })
      .mockResolvedValueOnce({ sent: true });

    await runBillingReminders();
    await runBillingReminders();

    const org = await Organization.findById(owner.user.orgId).select('+billingRemindersSent').lean();
    expect(send).toHaveBeenCalledTimes(2);
    expect(org.billingRemindersSent).toHaveLength(1);
  });

  it('treats a console delivery as sent so development logs are not re-sent every hour', async () => {
    const owner = await createTestUser();
    await paidUntil(owner.user.orgId, 6.5 * DAY);
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail')
      .mockResolvedValue({ sent: false, transport: 'console' });

    await runBillingReminders();
    await runBillingReminders();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ignores periods more than 7 days away and periods already over', async () => {
    const far = await createTestUser();
    await paidUntil(far.user.orgId, 10 * DAY);
    const send = jest.spyOn(emailService, 'sendBillingReminderEmail').mockResolvedValue({ sent: true });

    await runBillingReminders();
    await paidUntil(far.user.orgId, -DAY);
    await runBillingReminders();

    expect(send).not.toHaveBeenCalled();
  });
});
