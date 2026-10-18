// Cafe-local date arithmetic: the one home of the zoned and date-only helpers (BE-11-T01, BE-11-T05).
// Every caller outside the parser imports these from here.

let supportedZones = null;

// ICU's canonical list can lag IANA renames. Accept these current names as well,
// only when this runtime can actually use them, while keeping exact casing.
const IANA_RENAMES = ['Asia/Kolkata', 'Europe/Kyiv', 'Asia/Ho_Chi_Minh', 'Asia/Kathmandu',
  'America/Argentina/Buenos_Aires', 'America/Nuuk'];
const isSupportedTimezone = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (!supportedZones) {
    supportedZones = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
    for (const zone of IANA_RENAMES) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
        supportedZones.add(zone);
      } catch { /* A newer IANA name must still be supported by this runtime. */ }
    }
  }
  return supportedZones.has(value);
};

const DEFAULT_TIMEZONE = 'Africa/Johannesburg';
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// One formatter per zone, built the first time the zone is validated and reused for every row after. Building one
// is ICU work measured in tens of microseconds; the parse used to build ~18 per row (BE-03-T13).
const FORMATTERS = new Map();
const INVALID_ZONES = new Set();
const MAX_CACHED_ZONES = 1000; // a stored cafe setting names the zone, so both caches are bounded

const buildZonedPartsFormatter = (zone) => new Intl.DateTimeFormat('en-ZA', {
  timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const safeTimezone = (timezone) => {
  const candidate = String(timezone || DEFAULT_TIMEZONE);
  if (FORMATTERS.has(candidate)) return candidate;
  if (INVALID_ZONES.has(candidate)) return DEFAULT_TIMEZONE;
  try {
    const formatter = buildZonedPartsFormatter(candidate); // throws RangeError for an unknown zone
    if (FORMATTERS.size < MAX_CACHED_ZONES) FORMATTERS.set(candidate, formatter);
    return candidate;
  } catch {
    if (INVALID_ZONES.size < MAX_CACHED_ZONES) INVALID_ZONES.add(candidate);
    return DEFAULT_TIMEZONE;
  }
};

const zonedPartsFormatter = (timezone) => {
  const zone = safeTimezone(timezone);
  return FORMATTERS.get(zone) || buildZonedPartsFormatter(zone); // uncached only past the cap
};

const getTimeZoneOffsetMs = (date, timezone) => {
  const parts = zonedPartsFormatter(timezone).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return asUtc + date.getUTCMilliseconds() - date.getTime();
};

const zonedDateTimeToUtc = (
  { year, month, day, hour = 0, minute = 0, second = 0, ms = 0 },
  timezone
) => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timezone);
  return new Date(utcGuess - secondOffset);
};

const getZonedDateParts = (date, timezone) => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = zonedPartsFormatter(timezone).formatToParts(parsed);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
};

const dateOnlyParts = (value, timezone) => {
  const match = typeof value === 'string' ? String(value).trim().match(DATE_ONLY_RE) : null;
  if (match) {
    const parts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (
      check.getUTCFullYear() !== parts.year ||
      check.getUTCMonth() !== parts.month - 1 ||
      check.getUTCDate() !== parts.day
    ) return null;
    return parts;
  }
  const parts = getZonedDateParts(value, timezone);
  return parts && { year: parts.year, month: parts.month, day: parts.day };
};

const addDatePartsDays = (parts, days) => {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
};

const zonedDayStart = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(parts, timezone);
};

const zonedDayEnd = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(
    { ...parts, hour: 23, minute: 59, second: 59, ms: 999 },
    timezone
  );
};

const addZonedDays = (value, days, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(addDatePartsDays(parts, days), timezone);
};

const zonedDayOrdinal = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
};

const zonedDateKey = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

const zonedDayOfWeek = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
};

const processLocalCalendarDate = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
};

// A date-only value (a shift date, a leave day, an event day, an analytics bound) is stored
// as UTC midnight of its calendar day. These helpers are the only code that builds or reads
// that shape; the five controller copies they replace disagreed about empty input.
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parseDateOnly = (value) => {
  const match = String(value || '').match(DATE_ONLY_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
};

const formatDateOnly = (date) => new Date(date).toISOString().slice(0, 10);

const inclusiveDateOnlyDays = (start, end) => Math.floor((end - start) / 86400000) + 1;

/** The cafe-local calendar day of `now`, as a date-only value. */
const cafeLocalToday = (timezone, now = new Date()) => parseDateOnly(zonedDateKey(now, timezone));

/**
 * The cafe's IANA zone, or the default when the cafe or its field is missing.
 * Cafe is required here, not at the top: the parser loads this module and must not
 * load mongoose models.
 */
const getCafeTimezone = async (cafeId) => {
  const Cafe = require('../models/Cafe.model');
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  return safeTimezone(cafe?.timezone);
};

// A nominal UTC midnight is a date-only value; other stored dates are instants.
const storedDayKey = (date, timezone) => {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const isDateOnly = value.getUTCHours() === 0 && value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
  return isDateOnly ? value.toISOString().slice(0, 10) : zonedDateKey(value, timezone);
};

module.exports = {
  storedDayKey,
  isSupportedTimezone, DEFAULT_TIMEZONE, DATE_ONLY_RE, TIME_OF_DAY_RE, safeTimezone, zonedPartsFormatter, zonedDateTimeToUtc, getZonedDateParts,
  zonedDayStart, zonedDayEnd, addZonedDays, zonedDayOrdinal, zonedDateKey, zonedDayOfWeek, processLocalCalendarDate,
  parseDateOnly, formatDateOnly, inclusiveDateOnlyDays, cafeLocalToday, getCafeTimezone,
};
