// Transaction date and time parsing in the cafe timezone, and the date-range error.
// Moved from parser.service.js by BE-11-T01. BE-03-T06: 12-hour clocks, the file's own day/month order, named months,
// and no instant ever built with new Date(string) (it reads a naive string in the Node process zone, not the cafe's).
const { DEFAULT_TIMEZONE, getZonedDateParts, zonedDateTimeToUtc, zonedDayStart, addZonedDays, zonedDateKey } = require('../../utils/timezone');
const { parserLimits, createClientInputError } = require('./limits');
const { excelSerialDateToDate } = require('./xlsx');
const { setSourceRowNumbers, SOURCE_ROW_NUMBERS } = require('./rowErrors');

// "2:30 PM" was read as 02:30 and "12:15 AM" as midday: the old pattern had no meridiem and no end anchor.
// Fractions up to nine digits (.NET writes seven) are kept to the millisecond.
const CLOCK_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?\s*(?:([AaPp])\.?\s*[Mm]\.?)?$/;

const parseTimeParts = (timeValue) => {
  if (timeValue == null || timeValue === '') return null;
  if (timeValue instanceof Date) {
    return {
      hours: timeValue.getUTCHours(),
      minutes: timeValue.getUTCMinutes(),
      seconds: timeValue.getUTCSeconds(),
      milliseconds: 0,
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
      milliseconds: 0,
    };
  }
  const match = String(timeValue).trim().match(CLOCK_TIME_RE);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3] || '0', 10);
  const milliseconds = match[4] ? Math.min(999, Math.round(Number(`0.${match[4]}`) * 1000)) : 0;
  const meridiem = match[5] ? match[5].toLowerCase() : null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'a') hours = hours === 12 ? 0 : hours;
    else hours = hours === 12 ? 12 : hours + 12;
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds, milliseconds };
};

const plusMilliseconds = (date, milliseconds) => (date && milliseconds ? new Date(date.getTime() + milliseconds) : date);

const applyTimeParts = (date, timeValue, timezone = DEFAULT_TIMEZONE) => {
  const hasExplicitTime = timeValue != null && String(timeValue).trim() !== '';
  if (!hasExplicitTime) return date;
  const time = parseTimeParts(timeValue);
  if (!time) return null;
  const localDate = getZonedDateParts(date, timezone);
  if (!localDate) return null;
  return plusMilliseconds(zonedDateTimeToUtc({
    year: localDate.year,
    month: localDate.month,
    day: localDate.day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone), time.milliseconds);
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
    : { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 };
  if (!time) return null;
  return plusMilliseconds(zonedDateTimeToUtc({
    year,
    month,
    day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone), time.milliseconds);
};

// A numeric date followed by whatever the cell says about the time: "2026-09-03 23:30", "03/09/2026T14:30:00",
// "2026/09/14, 23:30:00" (en-ZA toLocaleString), "2026-09-14T23:30:00.1234567+02:00". The tail is read by readCellTime.
const COMBINED_DATE_TIME_RE = /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})(?:\s*,\s*|[T\s]+)(.+)$/;

// A zone the cell states itself: "Z", "+02:00", "+0200", "+00", "UTC", "GMT+0200 (South Africa Standard Time)".
// Only a stated zone may move a sale off the cafe zone; a naive time is the cafe's own clock.
const ZONE_NAME_RE = /\s*\([^)]*\)\s*$/;
const ZONE_SUFFIX_RE = /\s*(?:(?:GMT|UTC)\s*([+-]\d{2}(?::?\d{2})?)?|(Z)|([+-]\d{2}(?::?\d{2})?))$/i;
const MAX_OFFSET_MINUTES = 14 * 60;

const offsetMinutesOf = (offset) => {
  const sign = offset[0] === '-' ? -1 : 1;
  const digits = offset.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
};

/** A cell's time text split into the clock and any zone it states (null when it states none). */
const readCellTime = (text) => {
  const clean = String(text).replace(ZONE_NAME_RE, '').trim();
  const match = clean.match(ZONE_SUFFIX_RE);
  if (!match) return { time: clean, offsetMinutes: null };
  const offset = match[1] || match[3];
  return { time: clean.slice(0, match.index).trim(), offsetMinutes: offset ? offsetMinutesOf(offset) : 0 };
};

// Two-digit years are day-first too, like every other date an SA till writes.
// The pivot: 70-99 is the 1900s, 00-69 the 2000s, which covers every export
// that could plausibly be trading history without reaching a year that has not
// happened. Both ends are refused anyway by the min-year and future-day bounds.
const TWO_DIGIT_YEAR_PIVOT = 70;

const expandTwoDigitYear = (shortYear) =>
  (shortYear >= TWO_DIGIT_YEAR_PIVOT ? 1900 : 2000) + shortYear;

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const monthFromName = (name) => {
  const key = String(name).toLowerCase().replace(/\.$/, '');
  if (key === 'sept') return 9;
  const index = MONTH_NAMES.findIndex((full) => full === key || (key.length === 3 && full.startsWith(key)));
  return index >= 0 ? index + 1 : null;
};
const WEEKDAY_PREFIX_RE = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
const ORDINAL = '(?:st|nd|rd|th)?';
const SEP = '[\\s\\-/.]+';
const TAIL = '(?:[T\\s,]+(.+))?$';
// "14 Sep 2026", "14th Sep 2026", "14-Sep-2026"; "Sep 14, 2026", "Sep-14-2026"; "2026-Sep-14".
const DAY_MONTH_NAME_RE = new RegExp(`^(\\d{1,2})${ORDINAL}${SEP}([A-Za-z]{3,9}\\.?)[\\s\\-/.,]+(\\d{4}|\\d{2})${TAIL}`);
const MONTH_NAME_DAY_RE = new RegExp(`^([A-Za-z]{3,9}\\.?)${SEP}(\\d{1,2})${ORDINAL},?${SEP}(\\d{4})${TAIL}`);
const YEAR_MONTH_NAME_DAY_RE = new RegExp(`^(\\d{4})${SEP}([A-Za-z]{3,9}\\.?)${SEP}(\\d{1,2})${ORDINAL}${TAIL}`);

/** Dates that name their month, with any trailing time. */
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
  match = text.match(YEAR_MONTH_NAME_DAY_RE);
  if (match) {
    const month = monthFromName(match[2]);
    return month ? { year: Number(match[1]), month, day: Number(match[3]), time: match[4] } : null;
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
  const combined = value.match(COMBINED_DATE_TIME_RE);
  const numeric = numericDateParts(combined ? combined[1] : value, dateOrder);
  const named = numeric ? null : monthNameDateParts(value);
  const parts = numeric || named;
  // A bare number is not a date: new Date read "0" as the year 2000 and "45900" as the year 45899, and one junk cell
  // then widened the file's span far enough to have the whole upload refused. Anything unrecognised is a row error.
  if (!parts) return result(null, false);
  const fromParts = (time, zone) => dateFromParts(parts.year, parts.month, parts.day, time, zone);
  // A mapped Time column wins over any time in the date cell: it is the operator's explicit choice, on the cafe clock.
  if (hasText(timeValue)) return result(fromParts(timeValue, timezone), true);
  const cellTime = numeric ? combined?.[2] : named.time;
  if (!hasText(cellTime)) return result(fromParts(undefined, timezone), false);
  const { time, offsetMinutes } = readCellTime(cellTime);
  // "2026-09-14 (Mon)", "2026-09-14 Z": a zone with no clock says nothing about the hour.
  if (!hasText(time)) return result(fromParts(undefined, timezone), false);
  if (offsetMinutes === null) return result(fromParts(time, timezone), true);
  if (Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) return result(null, false);
  const wallClockAsUtc = fromParts(time, 'UTC');
  return result(wallClockAsUtc && new Date(wallClockAsUtc.getTime() - offsetMinutes * 60000), true);
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

const AMBIGUOUS_ORDER_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:(?:\s*,\s*|[T\s]).*)?$/;
const MERIDIEM_IN_CELL_RE = /\d\s*[ap]\.?\s*m\.?(?:\s|$)/i;

/**
 * Day-first or month-first, decided by the file's own values: a first number above 12 can only be a day, a second
 * number above 12 can only be a day in the month-first reading. Both in one file is a contradiction the owner must fix.
 * With neither, a date cell that carries a 12-hour clock ("9/3/2026 2:15:00 PM") is the en-US shape and stays
 * month-first, as new Date read it before; anything else keeps the South African default, day-first.
 */
const inferDayMonthOrder = (entries) => {
  let dayFirst = null;
  let monthFirst = null;
  let twelveHourCells = false;
  for (const { value, rowNumber } of entries) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    const match = text.match(AMBIGUOUS_ORDER_RE);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!twelveHourCells && MERIDIEM_IN_CELL_RE.test(text)) twelveHourCells = true;
    if (!dayFirst && first > 12 && second <= 12) dayFirst = { value: text, rowNumber };
    if (!monthFirst && second > 12 && first <= 12) monthFirst = { value: text, rowNumber };
    if (dayFirst && monthFirst) {
      throw createClientInputError(
        `This file mixes day-first and month-first dates: row ${dayFirst.rowNumber} reads ${dayFirst.value} and row `
        + `${monthFirst.rowNumber} reads ${monthFirst.value}. Export again with one date format.`
      );
    }
  }
  if (monthFirst) return 'MDY';
  if (dayFirst) return 'DMY';
  return twelveHourCells ? 'MDY' : 'DMY';
};

const isCafeMidnight = (date, timezone) => {
  const parts = getZonedDateParts(date, timezone);
  return parts.hour === 0 && parts.minute === 0 && parts.second === 0 && date.getUTCMilliseconds() === 0;
};

/**
 * A date-only column exported with a midnight time on every row ("2026-09-14 00:00:00", as SQL and Excel write a
 * date) is still date-only: each cell looks timed, but the file as a whole says no hour. Only a file with no mapped
 * Time column, whose every timed row sits at exactly 00:00 cafe time, is marked; one real time anywhere keeps them all.
 */
const markMidnightOnlyFileDateOnly = (rows, timezone) => {
  const timed = rows.filter((row) => row.hourKnown);
  if (timed.length === 0 || !timed.every((row) => isCafeMidnight(row.date, timezone))) return rows;
  return rows.map((row) => (row.hourKnown
    ? setSourceRowNumbers({ ...row, hourKnown: false, hour: null }, row[SOURCE_ROW_NUMBERS] || [])
    : row));
};

// Once per parse: the earliest and latest acceptable dates do not change from row to row (BE-03-T13).
const transactionDateBounds = (timezone, limits = parserLimits(), now = new Date()) => ({
  earliest: zonedDayStart(`${limits.minYear}-01-01`, timezone),
  latest: addZonedDays(now, limits.maxFutureDays, timezone),
  minYear: limits.minYear,
  maxFutureDays: limits.maxFutureDays,
});

const transactionDateError = (date, timezone, bounds = transactionDateBounds(timezone)) => {
  if (!date || Number.isNaN(date.getTime())) return 'Could not parse date or time';
  if (date < bounds.earliest) return `Transaction date is before ${bounds.minYear}`;
  if (date > bounds.latest) return `Transaction date is more than ${bounds.maxFutureDays} days in the future`;
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
  parseDate, parseDateTime, inferDayMonthOrder, markMidnightOnlyFileDateOnly, transactionDateBounds, transactionDateError,
  temporalFields,
};
