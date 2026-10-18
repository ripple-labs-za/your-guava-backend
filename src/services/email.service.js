const { DEFAULT_TIMEZONE, zonedDayOrdinal } = require('../utils/timezone');
const { Resend } = require('resend');
const { isRelaxedEnvironment } = require('../config/posture');

let client = null;

const appUrl = () => (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

const isConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);

const getClient = () => {
  if (!isConfigured()) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
};

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const plainLines = (lines) => lines.filter(Boolean).join('\n');

const cc = (code) => String.fromCharCode(code);
// C0 and C1 controls, zero-width and direction marks, line and paragraph separators, bidi embeddings and isolates.
const CONTROL_AND_DIRECTION_RE = new RegExp(
  `[${cc(0)}-${cc(0x1f)}${cc(0x7f)}-${cc(0x9f)}${cc(0x200b)}-${cc(0x200f)}${cc(0x2028)}${cc(0x2029)}${cc(0x202a)}-${cc(0x202e)}${cc(0x2066)}-${cc(0x2069)}]`,
  'g'
);
const SCHEME_LINK_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S*/gi;
const WWW_LINK_RE = /\bwww\.\S*/gi;
const DOMAIN_DOT_RE = /([a-z0-9])\.(?=[a-z]{2,})/gi;
const EMAIL_TEXT_MAX = 60;

/**
 * Names and cafe names come from any trial owner and go to arbitrary inboxes (identity-17). HTML escaping stops markup; this
 * also removes control and direction characters, anything link-like and the dot that makes a word read as a domain, then caps
 * the length. Input is cut to 500 characters first, so every pattern runs on a bounded string.
 */
const safeEmailText = (value, max = EMAIL_TEXT_MAX) => {
  const cleaned = String(value ?? '')
    .slice(0, 500)
    .replace(CONTROL_AND_DIRECTION_RE, ' ')
    .replace(SCHEME_LINK_RE, '[link removed]')
    .replace(WWW_LINK_RE, '[link removed]')
    .replace(DOMAIN_DOT_RE, '$1 .')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
};

const baseHtml = ({ title, intro, children, ctaLabel, ctaUrl }) => `
<!doctype html>
<html>
  <body style="margin:0;background:#0f0f0f;font-family:Arial,sans-serif;color:#f0f0f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0f0f0f;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 24px 10px;">
                <p style="margin:0 0 12px;font-size:13px;font-weight:700;">
                  <span style="color:#6b8e3a;">Your</span> <span style="color:#d43d3d;">Guava</span>
                </p>
                <h1 style="margin:0;color:#f0f0f0;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
                <p style="margin:12px 0 0;color:#b8b8b8;font-size:15px;line-height:1.6;">${escapeHtml(intro)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 24px 24px;color:#d8d8d8;font-size:14px;line-height:1.6;">
                ${children}
                ${
                  ctaLabel && ctaUrl
                    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#4da63b;color:#ffffff;text-decoration:none;padding:11px 16px;border-radius:8px;font-weight:700;">${escapeHtml(ctaLabel)}</a></p>`
                    : ''
                }
                <p style="margin:24px 0 0;color:#777777;font-size:12px;line-height:1.5;">
                  If you were not expecting this email, you can ignore it.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

/**
 * Development and test only. Nothing is delivered, so the result says sent:false; the calling flows still proceed because
 * deliveryAccepted() counts the console as a transport. Action links reach the log only with EMAIL_CONSOLE_LINKS=true: a
 * staging deploy without Resend used to print live reset tokens into its log store (security-7, identity-5).
 */
const consoleLinksEnabled = () => String(process.env.EMAIL_CONSOLE_LINKS || '').toLowerCase() === 'true';

const canUseConsoleTransport = () =>
  isRelaxedEnvironment() && String(process.env.EMAIL_DEV_CONSOLE || 'true').toLowerCase() !== 'false';

const deliverToConsole = ({ to, subject, text, html }) => {
  const body = text || String(html || '').replace(/<[^>]+>/g, ' ');
  const link = (body.match(/https?:\/\/\S+/) || [])[0];
  const printLink = Boolean(link) && consoleLinksEnabled();
  const linkLine = !link
    ? '  │ (no action link found in this message)'
    : printLink
      ? `  │ link:    ${link}`
      : '  │ link:    withheld (set EMAIL_CONSOLE_LINKS=true to print it)';
  console.warn(
    [
      '',
      '  ┌─ email not configured — delivering to console (development only) ─',
      `  │ to:      ${Array.isArray(to) ? to.join(', ') : to}`,
      `  │ subject: ${subject}`,
      linkLine,
      '  └───────────────────────────────────────────────────────────────────',
      '',
    ].join('\n')
  );
  return { sent: false, transport: 'console', linkLogged: printLink };
};

/** True when the flow may proceed: a real send, or the development console. */
const deliveryAccepted = (result) => result?.sent === true || result?.transport === 'console';

/** What register and invite responses tell the portal; the same for every address. */
const deliveryMode = () => (isConfigured() ? 'email' : canUseConsoleTransport() ? 'console' : 'none');

const deliveryCapability = () => {
  if (isConfigured()) return { ok: true, configured: true, mode: 'resend' };
  if (canUseConsoleTransport()) {
    return {
      ok: true,
      configured: false,
      mode: 'console',
      linksLogged: consoleLinksEnabled(),
      reason: consoleLinksEnabled()
        ? 'RESEND_API_KEY is not set; action links are written to the server log (development and test only)'
        : 'RESEND_API_KEY is not set; nothing is delivered and links are withheld (set EMAIL_CONSOLE_LINKS=true in development)',
    };
  }
  const missing = [
    !process.env.RESEND_API_KEY && 'RESEND_API_KEY',
    !process.env.RESEND_FROM_EMAIL && 'RESEND_FROM_EMAIL',
  ].filter(Boolean);
  return {
    ok: false,
    configured: false,
    mode: 'none',
    reason: `${missing.join(' and ')} not set: signup verification and team invites cannot be delivered`,
  };
};

const sendEmail = async ({ to, subject, html, text, tags }) => {
  const resend = getClient();
  if (!resend) {
    if (canUseConsoleTransport()) return deliverToConsole({ to, subject, text, html });
    return { skipped: true, reason: 'resend_not_configured' };
  }

  try {
    const payload = {
      from: process.env.RESEND_FROM_EMAIL,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
      ...(process.env.RESEND_REPLY_TO ? { replyTo: process.env.RESEND_REPLY_TO } : {}),
      ...(tags ? { tags } : {}),
    };
    const { data, error } = await resend.emails.send(payload);
    if (error) {
      console.error('[email] Resend send failed:', error);
      return { sent: false, error };
    }
    return { sent: true, data };
  } catch (error) {
    console.error('[email] Resend send failed:', error.message);
    return { sent: false, error };
  }
};

const sendWelcomeEmail = async ({ user, org, cafe }) => {
  const loginUrl = `${appUrl()}/login`;
  const userName = safeEmailText(user.name) || 'there';
  const orgName = safeEmailText(org?.name) || 'your organisation';
  const cafeName = safeEmailText(cafe?.name) || 'your first cafe';

  const html = baseHtml({
    title: 'Welcome to Your Guava',
    intro: `Hi ${userName}, your workspace is ready.`,
    ctaLabel: 'Open Your Guava',
    ctaUrl: loginUrl,
    children: `
      <p style="margin:0 0 14px;">You created <strong>${escapeHtml(orgName)}</strong> with <strong>${escapeHtml(cafeName)}</strong> as the first cafe location.</p>
      <p style="margin:0 0 14px;">Next, upload your sales data from the Connect Data page so Your Guava can start building forecasts and insights for your cafe.</p>
      <p style="margin:0;">Sign in any time with <strong>${escapeHtml(user.email)}</strong>.</p>
    `,
  });

  const text = plainLines([
    `Hi ${userName}, welcome to Your Guava.`,
    `Your workspace "${orgName}" is ready with "${cafeName}" as the first cafe location.`,
    'Next, upload your sales data from the Connect Data page so forecasts and insights can start working.',
    `Sign in: ${loginUrl}`,
  ]);

  return sendEmail({
    to: user.email,
    subject: 'Welcome to Your Guava',
    html,
    text,
    tags: [{ name: 'email_type', value: 'welcome' }],
  });
};

const buildVerificationEmail = ({ registration, verificationToken }) => {
  if (!verificationToken) throw new Error('Verification token is required');
  const verificationUrl = `${appUrl()}/verify-email#token=${encodeURIComponent(verificationToken)}`;
  const name = safeEmailText(registration.name) || 'there';
  const html = baseHtml({
    title: 'Verify your email address',
    intro: `Hi ${name}, confirm this email to finish creating your Your Guava workspace.`,
    ctaLabel: 'Verify email',
    ctaUrl: verificationUrl,
    children: `
      <p style="margin:0 0 14px;">Your workspace is not active yet. Verification prevents another person from registering with your email address.</p>
      <p style="margin:0;color:#b8b8b8;">This single-use link expires in 24 hours.</p>
    `,
  });
  const text = plainLines([
    `Hi ${name},`,
    'Verify your email to finish creating your Your Guava workspace.',
    `Verify email: ${verificationUrl}`,
    'This single-use link expires in 24 hours.',
  ]);
  return {
    to: registration.email,
    subject: 'Verify your Your Guava email',
    html,
    text,
    tags: [{ name: 'email_type', value: 'email_verification' }],
  };
};

const sendVerificationEmail = async (args) => sendEmail(buildVerificationEmail(args));

// Register answers an existing address exactly like a new one (identity-4); the real owner learns about the attempt here.
const sendAccountExistsEmail = async ({ user }) => {
  const loginUrl = `${appUrl()}/login`;
  const resetUrl = `${appUrl()}/forgot-password`;
  const html = baseHtml({
    title: 'You already have a Your Guava account',
    intro: 'Someone just tried to create a new account with this email address.',
    ctaLabel: 'Sign in',
    ctaUrl: loginUrl,
    children: `
      <p style="margin:0 0 14px;">If it was you, sign in instead. Forgotten your password? Reset it at <a href="${escapeHtml(resetUrl)}" style="color:#6b8e3a;">${escapeHtml(resetUrl)}</a>.</p>
      <p style="margin:0;color:#b8b8b8;">If it was not you, you do not need to do anything. Your account has not changed.</p>
    `,
  });
  const text = plainLines([
    'Someone just tried to create a new Your Guava account with this email address.',
    `If it was you, sign in: ${loginUrl}`,
    `Forgotten your password? ${resetUrl}`,
    'If it was not you, you do not need to do anything. Your account has not changed.',
  ]);
  return sendEmail({
    to: user.email,
    subject: 'You already have a Your Guava account',
    html,
    text,
    tags: [{ name: 'email_type', value: 'account_exists' }],
  });
};

const sendPasswordResetEmail = async ({ user, resetToken, expiresAt }) => {
  if (!resetToken) throw new Error('Password reset token is required');
  const resetUrl = `${appUrl()}/reset-password#token=${encodeURIComponent(resetToken)}`;
  const name = safeEmailText(user.name) || 'there';
  const expiry = new Date(expiresAt).toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const html = baseHtml({
    title: 'Reset your password',
    intro: `Hi ${name}, use this secure link to choose a new password.`,
    ctaLabel: 'Reset password',
    ctaUrl: resetUrl,
    children: `
      <p style="margin:0 0 14px;">This link expires at ${escapeHtml(expiry)} and works once.</p>
      <p style="margin:0;color:#b8b8b8;">If you did not request a reset, your password has not changed.</p>
    `,
  });
  const text = plainLines([
    `Hi ${name},`,
    `Reset your password: ${resetUrl}`,
    `This single-use link expires at ${expiry}.`,
    'If you did not request this, your password has not changed.',
  ]);
  return sendEmail({
    to: user.email,
    subject: 'Reset your Your Guava password',
    html,
    text,
    tags: [{ name: 'email_type', value: 'password_reset' }],
  });
};

const buildTeamInviteEmail = ({ invitation, owner, cafes = [], invitationToken }) => {
  if (!invitationToken) throw new Error('Invitation token is required');
  const invitationUrl = `${appUrl()}/accept-invite#token=${encodeURIComponent(invitationToken)}`;
  const inviteeName = safeEmailText(invitation.name) || 'there';
  const ownerName = safeEmailText(owner?.name) || 'The owner';
  const cafeNames = cafes.map((cafe) => safeEmailText(cafe?.name)).filter(Boolean);
  const cafeList = cafeNames.length > 0 ? cafeNames.join(', ') : 'assigned cafe locations';
  const expiresAt = new Date(invitation.expiresAt).toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const html = baseHtml({
    title: 'You have been invited to Your Guava',
    intro: `${ownerName} invited you to join as a manager.`,
    ctaLabel: 'Accept invitation',
    ctaUrl: invitationUrl,
    children: `
      <p style="margin:0 0 14px;">You can now access <strong>${escapeHtml(cafeList)}</strong> in Your Guava.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="margin:18px 0;width:100%;background:#111111;border:1px solid #2a2a2a;border-radius:8px;">
        <tr><td style="padding:14px;color:#888888;font-size:12px;">Email</td><td style="padding:14px;color:#f0f0f0;font-size:14px;">${escapeHtml(invitation.email)}</td></tr>
        <tr><td style="padding:14px;color:#888888;font-size:12px;border-top:1px solid #2a2a2a;">Expires</td><td style="padding:14px;color:#f0f0f0;font-size:14px;border-top:1px solid #2a2a2a;">${escapeHtml(expiresAt)}</td></tr>
      </table>
      <p style="margin:0;color:#b8b8b8;">Use the button above to choose your password. The link works once and expires automatically.</p>
    `,
  });

  const text = plainLines([
    `Hi ${inviteeName},`,
    `${ownerName} invited you to join Your Guava as a manager.`,
    `Cafe access: ${cafeList}`,
    `Email: ${invitation.email}`,
    `Invitation expires: ${expiresAt}`,
    `Accept invitation: ${invitationUrl}`,
    'Choose your password when you accept. The link works once.',
  ]);

  return {
    to: invitation.email,
    subject: 'You have been invited to Your Guava',
    html,
    text,
    tags: [{ name: 'email_type', value: 'team_invite' }],
  };
};

const sendTeamInviteEmail = async (args) => sendEmail(buildTeamInviteEmail(args));

const formatLongDate = (value) => new Intl.DateTimeFormat('en-ZA', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: DEFAULT_TIMEZONE,
}).format(new Date(value));

/** Pure, so the copy and the escaping are testable without a transport. */
const billingReminderMessage = ({ ownerName, orgName, planName, kind, endsAt, graceDays, now = new Date() }) => {
  ownerName = safeEmailText(ownerName) || 'there';
  orgName = safeEmailText(orgName) || 'your organisation';
  const billingUrl = `${appUrl()}/settings?section=billing`;
  const what = kind === 'trial' ? 'free trial' : `${planName} plan`;
  const calendarDays = zonedDayOrdinal(endsAt) - zonedDayOrdinal(now);
  const when = calendarDays === 0 ? 'today' : calendarDays === 1 ? 'tomorrow' : `on ${formatLongDate(endsAt)}`;
  const afterEnd = graceDays > 0
    ? `After it ends, Guava stays readable for ${graceDays} days (forecasts, analytics and history), but imports, edits and AI tools pause until payment.`
    : 'After it ends, Guava pauses until payment.';
  const subject = `Your Guava: your ${what} ends ${when}`;
  const html = baseHtml({
    title: `Your ${what} ends ${when}`,
    intro: `Hi ${ownerName || 'there'}, ${orgName}'s ${what} ends on ${formatLongDate(endsAt)}.`,
    ctaLabel: kind === 'trial' ? 'Choose a plan' : 'Renew in Billing',
    ctaUrl: billingUrl,
    children: `
      <p style="margin:0 0 14px;">Nothing renews automatically: pay for the next period in Billing to keep full access.</p>
      <p style="margin:0;color:#b8b8b8;">${escapeHtml(afterEnd)}</p>
    `,
  });
  const text = plainLines([
    `Hi ${ownerName || 'there'},`,
    `${orgName}'s ${what} ends on ${formatLongDate(endsAt)}.`,
    'Nothing renews automatically: pay for the next period in Billing to keep full access.',
    afterEnd,
    `Open Billing: ${billingUrl}`,
  ]);
  return { subject, html, text };
};

const sendBillingReminderEmail = async ({ to, daysLeft, kind, ...rest }) =>
  sendEmail({
    to,
    ...billingReminderMessage({ daysLeft, kind, ...rest }),
    tags: [{ name: 'email_type', value: `billing_reminder_${kind}_${daysLeft}d` }],
  });

const SECURITY_NOTICES = {
  password_changed: {
    subject: 'Your Your Guava password was changed',
    title: 'Your password was changed',
    line: () => 'The password for your Your Guava account was just changed, and your other sessions were signed out.',
  },
  password_reset: {
    subject: 'Your Your Guava password was reset',
    title: 'Your password was reset',
    line: () => 'Your Your Guava password was just reset with an emailed link, and every session was signed out.',
  },
  ownership_transferred_away: {
    subject: 'You are no longer the owner of your Your Guava organisation',
    title: 'Ownership was transferred',
    line: ({ orgName, counterpartName }) => `${orgName} is now owned by ${counterpartName}. You remain a manager.`,
  },
  ownership_received: {
    subject: 'You are now the owner of your Your Guava organisation',
    title: 'You are now the owner',
    line: ({ orgName, counterpartName }) => `${counterpartName} made you the owner of ${orgName}.`,
  },
};

// identity-16: the account holder hears about every change to who controls the account.
const buildSecurityNoticeEmail = ({ kind, user, orgName, counterpartName }) => {
  const notice = SECURITY_NOTICES[kind];
  if (!notice) throw new Error(`Unknown security notice: ${kind}`);
  const resetUrl = `${appUrl()}/forgot-password`;
  const line = notice.line({
    orgName: safeEmailText(orgName || 'your organisation'),
    counterpartName: safeEmailText(counterpartName || 'another member'),
  });
  const html = baseHtml({
    title: notice.title,
    intro: line,
    ctaLabel: 'Reset password',
    ctaUrl: resetUrl,
    children: '<p style="margin:0;">If this was not you, reset your password now and contact support@yourguava.co.za.</p>',
  });
  const text = plainLines([
    `Hi ${safeEmailText(user.name || 'there')},`,
    line,
    `If this was not you, reset your password now: ${resetUrl}`,
    'Then contact support@yourguava.co.za.',
  ]);
  return { to: user.email, subject: notice.subject, html, text, tags: [{ name: 'email_type', value: `security_${kind}` }] };
};

const sendSecurityNoticeEmail = (args) => sendEmail(buildSecurityNoticeEmail(args));

const _resetClient = () => {
  client = null;
};

module.exports = {
  billingReminderMessage,
  sendBillingReminderEmail,
  sendWelcomeEmail,
  sendVerificationEmail,
  sendAccountExistsEmail,
  sendPasswordResetEmail,
  sendTeamInviteEmail,
  sendEmail,
  sendSecurityNoticeEmail,
  safeEmailText,
  buildVerificationEmail,
  buildTeamInviteEmail,
  buildSecurityNoticeEmail,
  deliveryAccepted,
  deliveryMode,
  isConfigured,
  deliveryCapability,
  _resetClient,
};
