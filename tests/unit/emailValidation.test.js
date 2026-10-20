const { EMAIL_MAX_LENGTH, isValidEmail } = require('../../src/utils/email');

// The pattern every caller used until 22 Sep 2026. It is kept here only as the
// reference the new validator must agree with: it has to accept exactly what
// this accepted (users already stored are re-validated on every save), minus
// anything longer than an address can be.
const LEGACY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SAMPLES = [
  'a@b.c',
  'test@yourguava.com',
  'first.last+tag@sub.example.co.za',
  'ü@b.c',
  'a@.b.c',
  'a@b..c',
  'user@localhost.',
  'user@localhost',
  '',
  'plain',
  '@b.c',
  'a@b',
  'a@b.',
  'a@.b',
  'a b@c.d',
  'a@b@c.d',
  'a@b.c ',
  '\ta@b.c',
  'a@b.c\n',
  'a@b.c ',
  'a@@b.c',
  '.@b.c',
];

describe('isValidEmail', () => {
  it.each(SAMPLES)('agrees with the legacy pattern on %j', (value) => {
    expect(isValidEmail(value)).toBe(LEGACY_EMAIL_RE.test(value));
  });

  it('refuses anything longer than an address can be', () => {
    const longest = `${'a'.repeat(EMAIL_MAX_LENGTH - '@b.co'.length)}@b.co`;
    expect(longest).toHaveLength(EMAIL_MAX_LENGTH);
    expect(isValidEmail(longest)).toBe(true);
    expect(isValidEmail(`a${longest}`)).toBe(false);
  });

  it('refuses a non-string without throwing', () => {
    for (const value of [undefined, null, 42, {}, ['a@b.c']]) {
      expect(isValidEmail(value)).toBe(false);
    }
  });

  it('[budget] answers a megabyte of hostile input at once', () => {
    // "a@" + dots + "@" is the input that made the legacy pattern try every dot
    // as the split point: 1.4 s at 40,000 characters, quadratic beyond that.
    const hostile = [`a@${'.'.repeat(1_000_000)}@`, `a@${'b.'.repeat(500_000)} `, `${'a'.repeat(1_000_000)}@b.c`];
    for (const value of hostile) {
      const started = process.hrtime.bigint();
      expect(isValidEmail(value)).toBe(false);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(50);
    }
  });
});
