// Every non-HTTP caller of the shared email check answers a megabyte of
// hostile input inside the budget. HTTP callers cannot receive a megabyte
// (express.json refuses bodies over 100 KB); tests/integration/auth.test.js
// covers them at the largest body they accept.
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() },
})));

const User = require('../../src/models/User.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const { isValidEmail } = require('../../src/utils/email');
const { proposeColumnMapping } = require('../../src/services/anthropic.service');

const BUDGET_MS = 50;
const MEGABYTE = 1_000_000;
const hostile = `a@${'.'.repeat(MEGABYTE)}@`;

const timed = async (fn) => {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
};

describe('every caller of the email check answers hostile input at once', () => {
  beforeAll(async () => {
    // Warm the JIT so the first measured call is not compiling.
    isValidEmail('warm@up.co');
    await proposeColumnMapping(['Date', 'Flat White', '45.00'], [], {});
  });

  it('[budget] isValidEmail refuses a megabyte of dots in under 50 ms', async () => {
    const { value, ms } = await timed(() => isValidEmail(hostile));
    console.log(`isValidEmail 1 MB: ${ms.toFixed(2)} ms`);
    expect(value).toBe(false);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ['User', () => new User({ name: 'X', email: hostile, password: 'password123' })],
    ['TeamInvitation', () => new TeamInvitation({ email: hostile, name: 'X' })],
  ])('[budget] the %s model validator refuses a megabyte in under 50 ms', async (label, build) => {
    const doc = build();
    const { value, ms } = await timed(() => doc.validateSync(['email']));
    console.log(`${label} validateSync 1 MB: ${ms.toFixed(2)} ms`);
    expect(value?.errors?.email).toBeDefined();
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('[budget] the column-mapping privacy check reads a megabyte header in under 50 ms', async () => {
    // '45.00' makes the headers look headerless, so the call returns before
    // any provider client exists; the hostile header is checked first.
    const { value, ms } = await timed(() => proposeColumnMapping([hostile, 'Flat White', '45.00'], [], {}));
    console.log(`proposeColumnMapping 1 MB header: ${ms.toFixed(2)} ms`);
    expect(value).toEqual(expect.objectContaining({ aiUnavailableReason: 'sensitive_headers', aiCreditsCharged: 0 }));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('[budget] the budget is tight enough to catch the pattern it replaced', () => {
    const LEGACY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const probe = `a@${'.'.repeat(20_000)}@`;
    const started = process.hrtime.bigint();
    LEGACY_EMAIL_RE.test(probe);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`legacy pattern at 20,000 chars: ${ms.toFixed(1)} ms`);
    expect(ms).toBeGreaterThan(BUDGET_MS);
  });
});
