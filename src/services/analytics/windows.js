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
const trendWindows = ({ startDate, endDate, today, firstDataDate, lastDataDate, tradingHours = [] }) => {
  const completeEnd = lastCompleteDay({ endDate, today });
  if (completeEnd < startDate) return noTrend('window_not_complete');
  if (!lastDataDate) return noTrend('no_data_in_window');

  const closed = new Set(tradingHours.filter((day) => day.isOpen === false).map((day) => day.dayOfWeek));
  // A scheduled closure is a measured zero, not evidence that uploads ended.
  let lastExpectedDay = completeEnd;
  for (let i = 0; i < 7 && lastExpectedDay > startDate && closed.has(weekdayOf(lastExpectedDay)); i += 1) {
    lastExpectedDay = shiftDay(lastExpectedDay, -1);
  }
  const dataEnds = lastDataDate < lastExpectedDay;
  const effectiveEnd = dataEnds ? lastDataDate : completeEnd;
  const days = daysInclusive(startDate, effectiveEnd);
  let endReason = 'requested';
  if (dataEnds) endReason = 'data_ends';
  else if (endDate >= today) endReason = 'today_incomplete';

  const effective = { startDate, endDate: effectiveEnd, days, endReason };
  const comparison = { startDate: shiftDay(startDate, -days), endDate: shiftDay(startDate, -1), days };
  let firstExpectedDay = comparison.startDate;
  for (let i = 0; i < 7 && firstExpectedDay < comparison.endDate && closed.has(weekdayOf(firstExpectedDay)); i += 1) {
    firstExpectedDay = shiftDay(firstExpectedDay, 1);
  }
  if (!firstDataDate || firstDataDate > firstExpectedDay) {
    return noTrend('insufficient_history', effective, comparison);
  }
  return { effective, comparison, comparable: true, reason: null };
};

/**
 * The days in [fromDate, toDate] the cafe was open: its trading hours mark the weekday open, or it recorded a sale that day
 * (a cafe that trades on a day its settings call closed was open). Zero-sale open days are included on purpose.
 */
const openDaysBetween = ({ fromDate, toDate, tradingHours, saleDays }) => {
  const openWeekdays = new Set(tradingHours.filter((row) => row.isOpen).map((row) => row.dayOfWeek));
  const days = [];
  for (let day = fromDate; day <= toDate; day = shiftDay(day, 1)) {
    if (openWeekdays.has(weekdayOf(day)) || saleDays.has(day)) days.push(day);
  }
  return days;
};

const round2 = (value) => parseFloat(value.toFixed(2));

/**
 * Per-day summary over the observed span (first to last day with an approved row). `daily` is a
 * `{ _id: 'YYYY-MM-DD', revenue: <net>, transactions: <sales> }` group sorted by `_id`.
 */
const dailySummary = ({ daily, tradingHours }) => {
  if (daily.length === 0) return { openDays: 0, bestDay: null, worstDay: null };
  const revenueByDay = new Map(daily.map((row) => [row._id, row.revenue]));
  const saleDays = new Set(daily.filter((row) => row.transactions > 0).map((row) => row._id));
  const open = openDaysBetween({ fromDate: daily[0]._id, toDate: daily[daily.length - 1]._id, tradingHours, saleDays });
  if (open.length === 0) return { openDays: 0, bestDay: null, worstDay: null };
  const days = open.map((date) => ({ date, revenue: round2(revenueByDay.get(date) || 0) }));
  const bestDay = days.reduce((best, day) => (day.revenue > best.revenue ? day : best), days[0]);
  const worstDay = days.reduce((worst, day) => (day.revenue < worst.revenue ? day : worst), days[0]);
  return { openDays: open.length, bestDay, worstDay };
};

// MongoDB's $round for a double with a place: the double's value to 34 significant digits (Decimal128), then half to even.
// Used where a value can only be computed after the aggregation (getItems' avgPerDay needs the open-day count), so it rounds
// exactly as the old in-pipeline $round did. tests/unit/mongoRound.test.js compares it with the server on 4,400 quotients.
const mongoRound = (value, place = 0) => {
  if (!Number.isFinite(value) || value === 0) return value;
  const negative = value < 0;
  const [digits, exponent] = Math.abs(value).toExponential(33).split('e'); // 34 significant digits
  const mantissa = BigInt(digits.replace('.', ''));
  const shift = Number(exponent) - 33 + place; // |value| x 10^place = mantissa x 10^shift
  let quotient;
  if (shift >= 0) {
    quotient = mantissa * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    quotient = mantissa / divisor;
    const twice = (mantissa % divisor) * 2n;
    if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) quotient += 1n;
  }
  const rounded = Number(quotient) / 10 ** place;
  return negative ? -rounded : rounded;
};

module.exports = { shiftDay, daysInclusive, weekdayOf, lastCompleteDay, trendWindows, openDaysBetween, dailySummary, mongoRound };
