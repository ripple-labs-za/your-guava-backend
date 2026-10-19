const {
  objectIdString,
  requiredText,
  optionalText,
  parseHourlyRate,
  parseRole,
  parseBoolean,
  optionalEmail,
  assertPlainBody,
  parseEnum,
  LEAVE_TYPES,
  LEAVE_STATUSES,
} = require('../../src/services/workforce/input');

const outcome = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return `${error.statusCode} ${error.code} ${error.extra && error.extra.field}`;
  }
};

describe('workforce input (BE-08-T05)', () => {
  it('accepts only 24-hex-character ids', () => {
    expect(objectIdString('64b7f0c2a1b2c3d4e5f60718', 'staffId')).toBe('64b7f0c2a1b2c3d4e5f60718');
    for (const bad of [{ $ne: null }, ['64b7f0c2a1b2c3d4e5f60718'], 12, null, '', 'abc', '64b7f0c2a1b2c3d4e5f6071z',
      '64b7f0c2a1b2c3d4e5f60718extra', '64b7f0c2a1b2c3d4e5f60718a']) {
      expect(outcome(() => objectIdString(bad, 'staffId'))).toBe('400 INVALID_WORKFORCE_INPUT staffId');
    }
  });

  it('refuses single-element leave type and status arrays without string coercion', () => {
    expect(outcome(() => parseEnum(['annual'], LEAVE_TYPES, 'type'))).toBe('400 INVALID_WORKFORCE_INPUT type');
    expect(outcome(() => parseEnum(['approved'], LEAVE_STATUSES, 'status'))).toBe('400 INVALID_WORKFORCE_INPUT status');
  });

  it('refuses a blank, null or non-numeric pay rate instead of making it R0', () => {
    expect(parseHourlyRate(55, { required: true })).toBe(55);
    expect(parseHourlyRate('62.50', { required: true })).toBe(62.5);
    expect(parseHourlyRate(0, { required: true })).toBe(0);
    expect(parseHourlyRate(undefined, { required: false })).toBeUndefined();
    for (const bad of ['', '  ', null, 'abc', '1e3', -1, 10001, NaN, Infinity, [55], { $gt: 0 }, true, undefined]) {
      expect(outcome(() => parseHourlyRate(bad, { required: true }))).toBe('400 INVALID_WORKFORCE_INPUT hourlyRate');
    }
  });

  it('refuses null and unknown roles', () => {
    expect(parseRole('kitchen')).toBe('kitchen');
    expect(parseRole(undefined)).toBeUndefined();
    for (const bad of [null, '', 'chef', 'constructor', { $ne: 'x' }]) {
      expect(outcome(() => parseRole(bad))).toBe('400 INVALID_WORKFORCE_INPUT role');
    }
  });

  it('accepts only real booleans for isActive', () => {
    expect(parseBoolean(false, 'isActive')).toBe(false);
    expect(parseBoolean(undefined, 'isActive')).toBeUndefined();
    for (const bad of ['false', 0, null, {}]) {
      expect(outcome(() => parseBoolean(bad, 'isActive'))).toBe('400 INVALID_WORKFORCE_INPUT isActive');
    }
  });

  it('caps free text and refuses anything that is not a string', () => {
    expect(requiredText(` ${'x'.repeat(100)} `, 'name', 100)).toHaveLength(100);
    expect(outcome(() => requiredText('x'.repeat(101), 'name', 100))).toBe('400 INVALID_WORKFORCE_INPUT name');
    expect(outcome(() => requiredText('   ', 'name', 100))).toBe('400 INVALID_WORKFORCE_INPUT name');
    expect(outcome(() => requiredText(null, 'name', 100))).toBe('400 INVALID_WORKFORCE_INPUT name');
    expect(optionalText('', 'phone', 30)).toBe('');
    expect(outcome(() => optionalText(null, 'phone', 30))).toBe('400 INVALID_WORKFORCE_INPUT phone');
    expect(outcome(() => optionalText({ $gt: '' }, 'notes', 500))).toBe('400 INVALID_WORKFORCE_INPUT notes');
  });

  it('checks the email shape but lets an empty string clear it', () => {
    expect(optionalEmail('')).toBe('');
    expect(optionalEmail('Thandi@Cafe.co.za')).toBe('thandi@cafe.co.za');
    expect(outcome(() => optionalEmail('not-an-email'))).toBe('400 INVALID_WORKFORCE_INPUT email');
    expect(outcome(() => optionalEmail(`${'a'.repeat(250)}@b.co`))).toBe('400 INVALID_WORKFORCE_INPUT email');
  });

  it('refuses a body that is not a plain object', () => {
    expect(assertPlainBody(undefined)).toEqual({});
    expect(assertPlainBody({ a: 1 })).toEqual({ a: 1 });
    for (const bad of [[], [{ a: 1 }], 'text', 7, null]) {
      expect(outcome(() => assertPlainBody(bad))).toBe('400 INVALID_WORKFORCE_INPUT body');
    }
  });
});
