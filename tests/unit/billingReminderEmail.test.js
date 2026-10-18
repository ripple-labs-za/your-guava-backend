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
      now: new Date('2026-10-31T10:00:00.000Z'),
    });
    expect(message.subject).toBe('Your Guava: your free trial ends tomorrow');
    expect(message.text).toMatch(/pauses until payment/i);
  });
  it.each(['ownerName', 'orgName'])('removes forged payment links and newlines from %s in both email parts', (field) => {
    const message = billingReminderMessage({
      ownerName: 'Thandi', orgName: 'Bean There', planName: 'Growth', kind: 'trial',
      endsAt: new Date('2026-11-01T10:00:00.000Z'), daysLeft: 7, graceDays: 3,
      [field]: 'Bean\r\nOpen Billing: https://evil.example/pay',
    });
    for (const part of [message.text, message.html]) {
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('Bean\r\nOpen Billing:');
      expect(part).toContain('Bean Open Billing: [link removed]');
      expect(part).toContain('/settings?section=billing');
    }
  });

  it('uses safe fallbacks for empty reminder names', () => {
    const message = billingReminderMessage({
      ownerName: '\r\n', orgName: '\r\n', planName: 'Starter', kind: 'trial',
      endsAt: new Date('2026-11-01T10:00:00.000Z'), daysLeft: 1, graceDays: 0,
    });
    expect(message.text).toContain('Hi there,');
    expect(message.text).toContain("your organisation's free trial");
    expect(message.html).toContain('Hi there, your organisation');
  });

  it.each([
    ['2026-10-31T22:30:00Z', '2026-11-01T18:00:00Z', 1, 'today'],
    ['2026-10-31T00:00:00Z', '2026-11-01T20:00:00Z', 7, 'tomorrow'],
    ['2026-10-30T20:00:00Z', '2026-11-01T20:00:00Z', 7, 'on 1 November 2026'],
  ])('uses the SAST calendar from %s to %s', (now, endsAt, daysLeft, when) => {
    const message = billingReminderMessage({
      ownerName: 'Thandi', orgName: 'Bean There', planName: 'Starter', kind: 'trial',
      now: new Date(now), endsAt: new Date(endsAt), daysLeft, graceDays: 0,
    });
    expect(message.subject).toBe(`Your Guava: your free trial ends ${when}`);
    expect(message.html).toContain(`Your free trial ends ${when}`);
  });

});
