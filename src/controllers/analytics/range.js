// Date ranges for analytics: local day boundaries and the range meta, over utils/timezone (BE-11-T05).
// safeTimezone and getCafeTimezone are re-exported for the handlers; their one definition is utils/timezone.js.
const {
  DATE_ONLY_RE, zonedDateKey, safeTimezone, getCafeTimezone, zonedDayStart, zonedDayEnd, addZonedDays, zonedDayOrdinal,
} = require('../../utils/timezone');

const { daysInclusive, shiftDay } = require('../../services/analytics/windows');

const DEFAULT_ANALYTICS_RANGE_DAYS = 30;
const { analyticsMaxRangeDays } = require('../../services/analytics/limits');

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
  const maxDays = analyticsMaxRangeDays();
  if (
    startDate &&
    endDate &&
    inclusiveLocalDayCount(startDate, endDate, timezone) > maxDays
  ) {
    const error = new Error(`Analytics ranges cannot exceed ${maxDays} days`);
    error.statusCode = 400;
    error.details = { code: 'ANALYTICS_RANGE_TOO_LONG', maxDays };
    throw error;
  }
};

const invalidDays = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.details = { code: 'ANALYTICS_INVALID_DAYS', maxDays: analyticsMaxRangeDays() };
  return error;
};

// The last N cafe-local days ending today. The server owns the cafe's calendar, so the portal never computes it (WS-08-T06).
const daysWindow = (value, timezone) => {
  const maxDays = analyticsMaxRangeDays();
  const days = Number(value);
  if (!/^\d+$/.test(String(value)) || days < 1 || days > maxDays) {
    throw invalidDays(`days must be a whole number from 1 to ${maxDays}`);
  }
  const today = zonedDateKey(new Date(), timezone);
  return { $gte: zonedDayStart(shiftDay(today, -(days - 1)), timezone), $lte: zonedDayEnd(today, timezone) };
};

const buildDateMatch = (query, timezone) => {
  if (query.days !== undefined) {
    if (query.startDate !== undefined || query.endDate !== undefined) throw invalidDays('Use either days or startDate and endDate, not both');
    return daysWindow(query.days, timezone);
  }
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
    days: query.days !== undefined ? Number(query.days) : null,
    startDate: query.startDate || null,
    endDate: query.endDate || null,
    effectiveStartDate: dateMatch.$gte.toISOString(),
    effectiveEndDate: dateMatch.$lte.toISOString(),
    effectiveStartDay,
    effectiveEndDay,
    effectiveDays: daysInclusive(effectiveStartDay, effectiveEndDay),
    timezone,
    defaultWindowDays: DEFAULT_ANALYTICS_RANGE_DAYS,
    defaultedStartDate: !query.startDate && query.days === undefined,
    defaultedEndDate: !query.endDate && query.days === undefined,
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
  DEFAULT_ANALYTICS_RANGE_DAYS, safeTimezone, getCafeTimezone, localDayBoundaryUtc, inclusiveLocalDayCount,
  parseDateBoundary, buildDateMatch, analyticsRangeMeta, dateToString,
};
