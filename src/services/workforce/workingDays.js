const { getPublicHolidaysForYear } = require('../../utils/signals');
const { formatDateOnly } = require('../../utils/timezone');
const { DAY_MS } = require('./cafeCalendar');

const DEFAULT_WORK_DAYS = Object.freeze([1, 2, 3, 4, 5]);
const DAY_LABELS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const WEEK_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

const workPattern = (workDays) => (Array.isArray(workDays) && workDays.length > 0 ? workDays : DEFAULT_WORK_DAYS);

const describeWorkPattern = (workDays) => {
  const pattern = workPattern(workDays);
  return WEEK_ORDER.filter((day) => pattern.includes(day)).map((day) => DAY_LABELS[day]).join(', ');
};

const publicHolidaysBetween = (start, end) =>
  new Map(
    Array.from({ length: end.getUTCFullYear() - start.getUTCFullYear() + 1 }, (_, offset) => start.getUTCFullYear() + offset)
      .flatMap((year) => getPublicHolidaysForYear(year))
      .map((holiday) => [holiday.date, holiday.name])
  );

/**
 * Splits [start, end] (UTC-midnight date-only values, inclusive) into the
 * person's working dates that leave is charged for, and the public holidays
 * that fall on their working days, which the BCEA does not count as leave.
 * The calendar shows both: the person is away on either.
 */
const leaveDayBreakdown = (start, end, workDays) => {
  const pattern = new Set(workPattern(workDays));
  const holidays = publicHolidaysBetween(start, end);
  const dates = Array.from({ length: Math.floor((end - start) / DAY_MS) + 1 }, (_, offset) => new Date(start.getTime() + offset * DAY_MS))
    .filter((date) => pattern.has(date.getUTCDay()))
    .map((date) => formatDateOnly(date));
  const chargedDates = dates.filter((key) => !holidays.has(key));
  const holidayDates = dates.filter((key) => holidays.has(key)).map((key) => ({ date: key, name: holidays.get(key) }));
  return { days: chargedDates.length, chargedDates, holidayDates };
};

module.exports = { DEFAULT_WORK_DAYS, describeWorkPattern, leaveDayBreakdown };
