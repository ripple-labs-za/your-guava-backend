// Date ranges for analytics: local day boundaries and the range meta, over utils/timezone (BE-11-T05).
// safeTimezone and getCafeTimezone are re-exported for the handlers; their one definition is utils/timezone.js.
const {
  DATE_ONLY_RE, zonedDateKey, safeTimezone, getCafeTimezone, zonedDayStart, zonedDayEnd, addZonedDays, zonedDayOrdinal,
} = require('../../utils/timezone');

const { daysInclusive } = require('../../services/analytics/windows');

const DEFAULT_ANALYTICS_RANGE_DAYS = 30;
const MAX_ANALYTICS_RANGE_DAYS = 1830;

const localDayBoundaryUtc = (date, timezone, boundary = 'start', deltaDays = 0) => {
  const dayStart = addZonedDays(date, deltaDays, timezone);
  return boundary === 'end' ? zonedDayEnd(dayStart, timezone) : dayStart;
};

const inclusiveLocalDayCount = (startDate, endDate, timezone) =>
  Math.max(zonedDayOrdinal(endDate, timezone) - zonedDayOrdinal(startDate, timezone) + 1, 1);

const parseDateBoundary = (value, timezone, boundary = 'start') => {
  if (!value) return null;
  const str = String(value).trim();
  const invalid = () => {
    const error = new Error(`Invalid ${boundary === 'end' ? 'endDate' : 'startDate'}`);
    error.statusCode = 400;
    return error;
  };
  if (DATE_ONLY_RE.test(str)) {
    const bound = boundary === 'end' ? zonedDayEnd(str, timezone) : zonedDayStart(str, timezone);
    if (!bound) throw invalid();
    return bound;
  }
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) throw invalid();
  return parsed;
};

const assertDateRange = (startDate, endDate, timezone) => {
  if (startDate && endDate && startDate > endDate) {
    const error = new Error('startDate must be on or before endDate');
    error.statusCode = 400;
    throw error;
  }
  if (
    startDate &&
    endDate &&
    inclusiveLocalDayCount(startDate, endDate, timezone) > MAX_ANALYTICS_RANGE_DAYS
  ) {
    const error = new Error(`Analytics ranges cannot exceed ${MAX_ANALYTICS_RANGE_DAYS} days`);
    error.statusCode = 400;
    throw error;
  }
};

const buildDateMatch = (query, timezone) => {
  const endDate = query.endDate
    ? parseDateBoundary(query.endDate, timezone, 'end')
    : new Date();
  const startDate = query.startDate
    ? parseDateBoundary(query.startDate, timezone, 'start')
    : localDayBoundaryUtc(endDate, timezone, 'start', -(DEFAULT_ANALYTICS_RANGE_DAYS - 1));
  assertDateRange(startDate, endDate, timezone);
  return { $gte: startDate, $lte: endDate };
};

const analyticsRangeMeta = (query, dateMatch, timezone) => {
  const effectiveStartDay = zonedDateKey(dateMatch.$gte, timezone);
  const effectiveEndDay = zonedDateKey(dateMatch.$lte, timezone);
  return {
    startDate: query.startDate || null,
    endDate: query.endDate || null,
    effectiveStartDate: dateMatch.$gte.toISOString(),
    effectiveEndDate: dateMatch.$lte.toISOString(),
    effectiveStartDay,
    effectiveEndDay,
    effectiveDays: daysInclusive(effectiveStartDay, effectiveEndDay),
    timezone,
    defaultWindowDays: DEFAULT_ANALYTICS_RANGE_DAYS,
    defaultedStartDate: !query.startDate,
    defaultedEndDate: !query.endDate,
  };
};


const dateToString = (format, timezone) => ({
  $dateToString: {
    format,
    date: '$date',
    timezone,
  },
});

module.exports = {
  DEFAULT_ANALYTICS_RANGE_DAYS, MAX_ANALYTICS_RANGE_DAYS, safeTimezone, getCafeTimezone, localDayBoundaryUtc, inclusiveLocalDayCount,
  parseDateBoundary, buildDateMatch, analyticsRangeMeta, dateToString,
};
