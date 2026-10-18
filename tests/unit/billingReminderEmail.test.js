const { billingReminderMessage } = require('../../src/services/email.service');

describe('billingReminderMessage', () => {
  it('names the end date, the grace period and the way to pay, and escapes the organisation name', () => {
    const message = billingReminderMessage({
      ownerName: 'Thandi',
      orgName: '<script>alert(1)</script> Cafe',
      planName: 'Growth',
      kind: 'paid',
      endsAt: new Date('2026-11-01T10:00:00.000Z'),
      daysLeft: 7,
      graceDays: 3,
    });
    expect(message.subject).toBe('Your Guava: your Growth plan ends on 1 November 2026');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).not.toContain('<script>alert');
    expect(message.text).toMatch(/nothing renews automatically/i);
    expect(message.text).toMatch(/readable for 3 days/i);
    expect(message.text).toMatch(/\/settings\?section=billing/);
  });

  it('says tomorrow for the last reminder and speaks of a trial for a trialling org', () => {
    const message = billingReminderMessage({
      ownerName: 'Thandi', orgName: 'Bean There', planName: 'Starter', kind: 'trial',
      endsAt: new Date('2026-11-01T10:00:00.000Z'), daysLeft: 1, graceDays: 0,
    });
    expect(message.subject).toBe('Your Guava: your free trial ends tomorrow');
    expect(message.text).toMatch(/pauses until payment/i);
  });
});
