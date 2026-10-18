const { WorkforceError } = require('./errors');
const { parseDateOnly } = require('../../utils/timezone');
const { isValidEmail } = require('../../utils/email');

const WORKFORCE_TEXT_LIMITS = Object.freeze({ name: 100, email: 254, phone: 30, notes: 500, reason: 500 });
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const invalid = (field, message) => new WorkforceError(400, 'INVALID_WORKFORCE_INPUT', message, { field });

// Exactly 24 hex characters: an operator object such as {"$ne": null}, an
// array or a number never reaches a Mongo filter through here.
const objectIdString = (value, field) => {
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) {
    throw invalid(field, `${field} must be a 24-character id`);
  }
  return value;
};

const requiredText = (value, field, max) => {
  if (typeof value !== 'string' || !value.trim()) throw invalid(field, `${field} is required`);
  const text = value.trim();
  if (text.length > max) throw invalid(field, `${field} must be ${max} characters or fewer`);
  return text;
};

// undefined: not sent, leave the field alone. '' clears it. Anything that is
// not a string (null, a number, an object) is refused, never coerced.
const optionalText = (value, field, max) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, `${field} must be text`);
  const text = value.trim();
  if (text.length > max) throw invalid(field, `${field} must be ${max} characters or fewer`);
  return text;
};

const dateOnlyInput = (value, field) => {
  const date = typeof value === 'string' ? parseDateOnly(value) : null;
  if (!date) throw invalid(field, `${field} must be a real date in YYYY-MM-DD form`);
  return date;
};

// 1 to 7 whole numbers from 0 (Sunday) to 6 (Saturday); stored unique and ascending.
const parseWorkDays = (value, field = 'workDays') => {
  if (value === undefined) return undefined;
  const valid =
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 7 &&
    value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!valid) throw invalid(field, 'workDays must list the days worked as numbers from 0 (Sunday) to 6 (Saturday)');
  return [...new Set(value)].sort((a, b) => a - b);
};

const STAFF_ROLES = Object.freeze(['barista', 'kitchen', 'front', 'manager', 'other']);
const SHIFT_STATUSES = Object.freeze(['scheduled', 'completed', 'cancelled']);
const LEAVE_TYPES = Object.freeze(['annual', 'sick', 'family', 'unpaid']);
const LEAVE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);
const MAX_HOURLY_RATE = 10000;
const RATE_TEXT_RE = /^\s*\d+(\.\d+)?\s*$/;

const assertPlainBody = (body) => {
  if (body === undefined) return {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('body', 'The request body must be a JSON object');
  }
  return body;
};

// Blank input must never become a zero pay rate through Number coercion.
const parseHourlyRate = (value, { required }) => {
  if (value === undefined && !required) return undefined;
  const rate = typeof value === 'number' ? value : typeof value === 'string' && RATE_TEXT_RE.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_HOURLY_RATE) {
    throw invalid('hourlyRate', `hourlyRate must be a number from 0 to ${MAX_HOURLY_RATE}`);
  }
  return rate;
};

const parseEnum = (value, allowed, field) => {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(field, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
};

const parseRole = (value) => (value === undefined ? undefined : parseEnum(value, STAFF_ROLES, 'role'));

const parseBoolean = (value, field) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalid(field, `${field} must be true or false`);
  return value;
};

const optionalEmail = (value, field = 'email') => {
  const text = optionalText(value, field, WORKFORCE_TEXT_LIMITS.email);
  if (text === undefined || text === '') return text;
  if (!isValidEmail(text)) throw invalid(field, `${field} must be an email address, or empty`);
  return text.toLowerCase();
};

module.exports = {
  WORKFORCE_TEXT_LIMITS,
  invalid,
  objectIdString,
  requiredText,
  optionalText,
  dateOnlyInput,
  parseWorkDays,
  STAFF_ROLES, SHIFT_STATUSES, LEAVE_TYPES, LEAVE_STATUSES, MAX_HOURLY_RATE,
  assertPlainBody, parseHourlyRate, parseEnum, parseRole, parseBoolean, optionalEmail,
};
