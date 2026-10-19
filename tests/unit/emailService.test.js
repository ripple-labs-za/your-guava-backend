const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));
const email = require('../../src/services/email.service');
const logger = require('../../src/utils/logger');

describe('email service over Resend', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'Your Guava <hello@yourguava.example>';
    process.env.CLIENT_URL = 'https://portal.yourguava.example';
    delete process.env.RESEND_REPLY_TO;
    email._resetClient();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the verification link with the token only in the URL fragment', async () => {
    const result = await email.sendVerificationEmail({
      registration: { name: 'Thandi', email: 'thandi@yourguava.example' }, verificationToken: 'abc/123',
    });
    expect(result).toEqual(expect.objectContaining({ sent: true }));
    const payload = mockSend.mock.calls[0][0];
    expect(payload.to).toEqual(['thandi@yourguava.example']);
    expect(payload.from).toBe('Your Guava <hello@yourguava.example>');
    expect(payload.text).toContain('https://portal.yourguava.example/verify-email#token=abc%2F123');
    expect(payload.replyTo).toBeUndefined();
  });

  it('escapes a registrant name in the HTML body', async () => {
    await email.sendVerificationEmail({
      registration: { name: '<script>alert(1)</script>', email: 'x@yourguava.example' }, verificationToken: 't',
    });
    const { html } = mockSend.mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('puts the reset and invitation tokens in fragments too', async () => {
    await email.sendPasswordResetEmail({ user: { name: 'A', email: 'a@yourguava.example' }, resetToken: 'r1', expiresAt: new Date() });
    await email.sendTeamInviteEmail({
      invitation: { name: 'B', email: 'b@yourguava.example', expiresAt: new Date() },
      owner: { name: 'Owner' }, cafes: [{ name: 'Cafe' }], invitationToken: 'i1',
    });
    expect(mockSend.mock.calls[0][0].text).toContain('/reset-password#token=r1');
    expect(mockSend.mock.calls[1][0].text).toContain('/accept-invite#token=i1');
  });

  it('reports sent:false when Resend answers an error or the call throws, and logs both', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    mockSend.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', message: 'bad from' } });
    expect((await email.sendEmail({ to: 'a@yourguava.example', subject: 's', text: 't' })).sent).toBe(false);
    mockSend.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await email.sendEmail({ to: 'a@yourguava.example', subject: 's', text: 't' })).sent).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls.map(([event]) => event)).toEqual(['email_send_failed', 'email_send_failed']);
  });

  it('reports an outbound timeout as timedOut without logging it as a failure', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    // withDeadline turns a TimeoutError into its OutboundTimeoutError, which sendEmail reports, not logs.
    mockSend.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    const result = await email.sendEmail({ to: 'a@yourguava.example', subject: 's', text: 't' });
    expect(result).toEqual(expect.objectContaining({ sent: false, timedOut: true }));
    expect(error).not.toHaveBeenCalled();
  });

  it('adds replyTo only when RESEND_REPLY_TO is set', async () => {
    process.env.RESEND_REPLY_TO = 'support@yourguava.example';
    await email.sendEmail({ to: 'a@yourguava.example', subject: 's', text: 't' });
    expect(mockSend.mock.calls[0][0].replyTo).toBe('support@yourguava.example');
  });

  it('refuses to send a verification or invitation without a token', async () => {
    await expect(email.sendVerificationEmail({ registration: { name: 'A', email: 'a@x.example' } })).rejects.toThrow(/token/i);
    await expect(email.sendTeamInviteEmail({ invitation: {}, owner: {} })).rejects.toThrow(/token/i);
  });

  it('reports Resend delivery capability when configured, and none in production without a key', () => {
    expect(email.deliveryCapability()).toEqual(expect.objectContaining({ ok: true, mode: 'resend' }));
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    try {
      expect(email.deliveryCapability()).toEqual(expect.objectContaining({ ok: false, mode: 'none' }));
      expect(email.deliveryCapability().reason).toMatch(/RESEND_API_KEY/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
