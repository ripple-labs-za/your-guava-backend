// Cafe-local calendar arithmetic on 'YYYY-MM-DD' day keys. There is no timezone maths in this file: callers turn
// instants into keys with zonedDateKey(date, timezone) and keys back into instants with zonedDayStart/zonedDayEnd.
// Working on keys is what keeps a 7-day window 7 days long in every timezone and across daylight-saving changes.
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const dayUtc = (dayKey) => {
  if (typeof dayKey !== 'string' || !DAY_KEY_RE.test(dayKey)) {
    throw new TypeError(`Expected a YYYY-MM-DD day key, got ${dayKey}`);
  }
  const [year, month, day] = dayKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
};

const shiftDay = (dayKey, days) => new Date(dayUtc(dayKey) + days * DAY_MS).toISOString().slice(0, 10);
const daysInclusive = (fromDay, toDay) => Math.round((dayUtc(toDay) - dayUtc(fromDay)) / DAY_MS) + 1;
const weekdayOf = (dayKey) => new Date(dayUtc(dayKey)).getUTCDay();

// Today is still trading (or not uploaded yet), so a window that reaches today is only complete up to yesterday.
const lastCompleteDay = ({ endDate, today }) => (endDate >= today ? shiftDay(today, -1) : endDate);

const noTrend = (reason, effective = null, comparison = null) => ({ effective, comparison, comparable: false, reason });

/**
 * The two equal spans a trend may compare. The current span runs from the requested start to the last complete day that has
 * data; the comparison span is the same number of days immediately before it. A trend is only comparable when the cafe's
 * history reaches back to the start of the comparison span, so a new cafe is never told it grew "from nothing".
 * @param {{ startDate: string, endDate: string, today: string, firstDataDate: string|null, lastDataDate: string|null }} input
 *   lastDataDate must be the last day with an approved row in [startDate, lastCompleteDay({ endDate, today })].
 */
const trendWindows = ({ startDate, endDate, today, firstDataDate, lastDataDate }) => {
  const completeEnd = lastCompleteDay({ endDate, today });
  if (completeEnd < startDate) return noTrend('window_not_complete');
  if (!lastDataDate) return noTrend('no_data_in_window');

  const dataEnds = lastDataDate < completeEnd;
  const effectiveEnd = dataEnds ? lastDataDate : completeEnd;
  const days = daysInclusive(startDate, effectiveEnd);
  let endReason = 'requested';
  if (dataEnds) endReason = 'data_ends';
  else if (endDate >= today) endReason = 'today_incomplete';

  const effective = { startDate, endDate: effectiveEnd, days, endReason };
  const comparison = { startDate: shiftDay(startDate, -days), endDate: shiftDay(startDate, -1), days };
  if (!firstDataDate || firstDataDate > comparison.startDate) {
    return noTrend('insufficient_history', effective, comparison);
  }
  return { effective, comparison, comparable: true, reason: null };
};

module.exports = { shiftDay, daysInclusive, weekdayOf, lastCompleteDay, trendWindows };
