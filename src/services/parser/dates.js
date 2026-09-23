// Transaction date and time parsing in the cafe timezone, and the date-range error.
// Moved from parser.service.js by BE-11-T01. BE-03-T06: 12-hour clocks, the file's own day/month order, named months,
// and no instant ever built with new Date(string) (it reads a naive string in the Node process zone, not the cafe's).
const { DEFAULT_TIMEZONE, getZonedDateParts, zonedDateTimeToUtc, zonedDayStart, addZonedDays, zonedDateKey } = require('../../utils/timezone');
const { parserLimits, createClientInputError } = require('./limits');
const { excelSerialDateToDate } = require('./xlsx');

// "2:30 PM" was read as 02:30 and "12:15 AM" as midday: the old pattern had no meridiem and no end anchor.
const CLOCK_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d{1,6})?\s*(?:([AaPp])\.?\s*[Mm]\.?)?$/;

const parseTimeParts = (timeValue) => {
  if (timeValue == null || timeValue === '') return null;
  if (timeValue instanceof Date) {
    return {
      hours: timeValue.getUTCHours(),
      minutes: timeValue.getUTCMinutes(),
      seconds: timeValue.getUTCSeconds(),
    };
  }
  if (typeof timeValue === 'number') {
    if (!Number.isFinite(timeValue)) return null;
    const dayFraction = ((timeValue % 1) + 1) % 1;
    const totalSeconds = Math.round(dayFraction * 24 * 60 * 60);
    return {
      hours: Math.floor(totalSeconds / 3600) % 24,
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }
  const match = String(timeValue).trim().match(CLOCK_TIME_RE);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3] || '0', 10);
  const meridiem = match[4] ? match[4].toLowerCase() : null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'a') hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds };
};

const applyTimeParts = (date, timeValue, timezone = DEFAULT_TIMEZONE) => {
  const hasExplicitTime = timeValue != null && String(timeValue).trim() !== '';
  if (!hasExplicitTime) return date;
  const time = parseTimeParts(timeValue);
  if (!time) return null;
  const localDate = getZonedDateParts(date, timezone);
  if (!localDate) return null;
  return zonedDateTimeToUtc({
    year: localDate.year,
    month: localDate.month,
    day: localDate.day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone);
};

const dateFromParts = (year, month, day, timeValue, timezone = DEFAULT_TIMEZONE) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const time = timeValue != null && String(timeValue).trim() !== ''
    ? parseTimeParts(timeValue)
    : { hours: 0, minutes: 0, seconds: 0 };
  if (!time) return null;
  return zonedDateTimeToUtc({
    year,
    month,
    day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone);
};

// A cell carrying its own time -- "2026-09-03 23:30", "03/09/2026T14:30:00", now also with fractional seconds and AM/PM.
// Built from its parts in the cafe zone. The end anchor keeps an offset-qualified timestamp out (see parseOffsetTimestamp).
const COMBINED_DATE_TIME_RE =
  /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})[T\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,6})?(?:\s*[AaPp]\.?\s*[Mm]\.?)?)$/;

// Only a timestamp that states its own offset may skip the cafe zone, and it is built from its parts, not new Date(string).
const OFFSET_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;

// Two-digit years are day-first too, like every other date an SA till writes.
// The pivot: 70-99 is the 1900s, 00-69 the 2000s, which covers every export
// that could plausibly be trading history without reaching a year that has not
// happened. Both ends are refused anyway by the min-year and future-day bounds.
const TWO_DIGIT_YEAR_PIVOT = 70;

const expandTwoDigitYear = (shortYear) =>
  (shortYear >= TWO_DIGIT_YEAR_PIVOT ? 1900 : 2000) + shortYear;

const parseOffsetTimestamp = (value) => {
  const match = value.match(OFFSET_TIMESTAMP_RE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', fraction = '0', zone] = match;
  if (!dateFromParts(Number(year), Number(month), Number(day), '00:00', 'UTC')) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const sign = zone[0] === '-' ? -1 : 1;
  const offsetMinutes = zone.toUpperCase() === 'Z'
    ? 0
    : sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  const ms = Math.round(Number(`0.${fraction}`) * 1000);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), ms)
    - offsetMinutes * 60000);
};

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const monthFromName = (name) => {
  const key = String(name).toLowerCase().replace(/\.$/, '');
  if (key === 'sept') return 9;
  const index = MONTH_NAMES.findIndex((full) => full === key || (key.length === 3 && full.startsWith(key)));
  return index >= 0 ? index + 1 : null;
};
const WEEKDAY_PREFIX_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
const DAY_MONTH_NAME_RE = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9}\.?)[\s\-/.,]+(\d{4}|\d{2})(?:[T\s,]+(.+))?$/;
const MONTH_NAME_DAY_RE = /^([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:[T\s,]+(.+))?$/;

/** "14 Sep 2026 23:30", "14-Sep-2026", "Sep 14, 2026 11:30 PM" → parts and any trailing time. */
const monthNameDateParts = (value) => {
  const text = value.replace(WEEKDAY_PREFIX_RE, '');
  let match = text.match(DAY_MONTH_NAME_RE);
  if (match) {
    const month = monthFromName(match[2]);
    const year = match[3].length === 2 ? expandTwoDigitYear(Number(match[3])) : Number(match[3]);
    return month ? { year, month, day: Number(match[1]), time: match[4] } : null;
  }
  match = text.match(MONTH_NAME_DAY_RE);
  if (match) {
    const month = monthFromName(match[1]);
    return month ? { year: Number(match[3]), month, day: Number(match[2]), time: match[4] } : null;
  }
  return null;
};

/** Numeric dates. Year-first is unambiguous; NN/NN/YY(YY) follows the file's inferred order. */
const numericDateParts = (datePart, dateOrder = 'DMY') => {
  let match = datePart.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  match = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (!match) return null;
  // Nothing used to match a two-digit year, so "03/09/26" fell through to V8's month-first reading; it follows the
  // file's order like every other NN/NN date.
  const year = match[3].length === 2 ? expandTwoDigitYear(Number(match[3])) : Number(match[3]);
  const [first, second] = [Number(match[1]), Number(match[2])];
  return dateOrder === 'MDY' ? { year, month: first, day: second } : { year, month: second, day: first };
};

const hasText = (value) => value != null && String(value).trim() !== '';
const result = (date, timeKnown) =>
  (date && !Number.isNaN(date.getTime()) ? { date, timeKnown } : { date: null, timeKnown: false });

const parseDateString = (dateValue, timeValue, timezone, { dateOrder = 'DMY' } = {}) => {
  const value = String(dateValue).trim();
  const offset = parseOffsetTimestamp(value);
  if (offset) return result(hasText(timeValue) ? applyTimeParts(offset, timeValue, timezone) : offset, true);

  const combined = value.match(COMBINED_DATE_TIME_RE);
  const numeric = numericDateParts(combined ? combined[1] : value, dateOrder);
  const named = numeric ? null : monthNameDateParts(value);
  const parts = numeric || named;
  // A bare number is not a date: new Date read "0" as the year 2000 and "45900" as the year 45899, and one junk cell
  // then widened the file's span far enough to have the whole upload refused. Anything unrecognised is a row error.
  if (!parts) return result(null, false);
  const cellTime = combined?.[2] ?? named?.time;
  // A mapped Time column still wins: it is the operator's explicit choice.
  const time = hasText(timeValue) ? timeValue : cellTime;
  return result(dateFromParts(parts.year, parts.month, parts.day, time, timezone), hasText(time));
};

/** The instant of a sale, and whether the file actually said what time it happened. */
const parseDateTime = (dateValue, timeValue, timezone = DEFAULT_TIMEZONE, context = {}) => {
  if (!dateValue) return result(null, false);
  const timeGiven = hasText(timeValue) || timeValue instanceof Date;
  if (dateValue instanceof Date) {
    // Read the parts straight off the cell's Date: a copy built from it is exactly what the hygiene test forbids.
    const clock = [dateValue.getUTCHours(), dateValue.getUTCMinutes(), dateValue.getUTCSeconds()];
    const sourceTime = timeGiven
      ? timeValue
      : `${clock[0]}:${String(clock[1]).padStart(2, '0')}:${String(clock[2]).padStart(2, '0')}`;
    const date = dateFromParts(
      dateValue.getUTCFullYear(), dateValue.getUTCMonth() + 1, dateValue.getUTCDate(), sourceTime, timezone
    );
    // A spreadsheet date cell with no time is midnight; only a time column or a non-midnight cell says the hour.
    return result(date, timeGiven || clock.some((part) => part !== 0));
  }
  if (typeof dateValue === 'number') {
    const date = excelSerialDateToDate(dateValue, timezone);
    if (date) return result(applyTimeParts(date, timeValue, timezone), timeGiven || dateValue % 1 !== 0);
  }
  return parseDateString(dateValue, timeValue, timezone, context);
};

const parseDate = (dateValue, timeValue, timezone, context) => parseDateTime(dateValue, timeValue, timezone, context).date;

const AMBIGUOUS_ORDER_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T\s].*)?$/;

/**
 * Day-first or month-first, decided by the file's own values: a first number above 12 can only be a day, a second
 * number above 12 can only be a day in the month-first reading. Both in one file is a contradiction the owner must fix.
 * Neither keeps the South African default, day-first.
 */
const inferDayMonthOrder = (entries) => {
  let dayFirst = null;
  let monthFirst = null;
  for (const { value, rowNumber } of entries) {
    if (typeof value !== 'string') continue;
    const match = value.trim().match(AMBIGUOUS_ORDER_RE);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!dayFirst && first > 12 && second <= 12) dayFirst = { value: value.trim(), rowNumber };
    if (!monthFirst && second > 12 && first <= 12) monthFirst = { value: value.trim(), rowNumber };
    if (dayFirst && monthFirst) {
      throw createClientInputError(
        `This file mixes day-first and month-first dates: row ${dayFirst.rowNumber} reads ${dayFirst.value} and row `
        + `${monthFirst.rowNumber} reads ${monthFirst.value}. Export again with one date format.`
      );
    }
  }
  return monthFirst ? 'MDY' : 'DMY';
};

const transactionDateError = (date, timezone) => {
  const limits = parserLimits();
  const earliest = zonedDayStart(`${limits.minYear}-01-01`, timezone);
  const latest = addZonedDays(new Date(), limits.maxFutureDays, timezone);
  if (!date || Number.isNaN(date.getTime())) return 'Could not parse date or time';
  if (date < earliest) return `Transaction date is before ${limits.minYear}`;
  if (date > latest) return `Transaction date is more than ${limits.maxFutureDays} days in the future`;
  return null;
};

const temporalFields = (date, timezone, { timeKnown = true } = {}) => {
  const parts = getZonedDateParts(date, timezone);
  return {
    // null, not 0: a date-only export does not say its sales happened at midnight.
    hour: timeKnown ? parts.hour : null,
    hourKnown: timeKnown,
    dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    // The cafe-local trading day. Receipt numbers are only unique within a day
    // on tills that restart their numbering, so identity has to be scoped by it.
    dateKey: zonedDateKey(date, timezone),
  };
};

module.exports = {
  parseDate, parseDateTime, inferDayMonthOrder, transactionDateError, temporalFields,
};
