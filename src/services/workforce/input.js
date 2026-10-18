const { WorkforceError } = require('./errors');
const { parseDateOnly } = require('../../utils/timezone');

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

module.exports = { WORKFORCE_TEXT_LIMITS, invalid, objectIdString, requiredText, optionalText, dateOnlyInput };
