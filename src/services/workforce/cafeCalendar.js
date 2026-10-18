const { cafeLocalToday, getCafeTimezone } = require('../../utils/timezone');

const DAY_MS = 86400000;

// Workforce dates (shift dates, leave start and end, Staff.startDate) are
// stored as 00:00 UTC of their calendar day. This truncates any instant to that.
const utcDateOnly = (value) => {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

// The cafe's own calendar day at `now`, as a UTC-midnight date-only value, so
// "today" and "this week" follow the cafe, not the server's clock.
// getCafeTimezone never throws for a missing cafe; it returns the default zone.
const cafeToday = async (cafeId, now = new Date()) => cafeLocalToday(await getCafeTimezone(cafeId), now);

module.exports = { DAY_MS, utcDateOnly, cafeToday };
