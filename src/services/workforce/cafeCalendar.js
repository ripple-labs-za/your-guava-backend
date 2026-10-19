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

// The cafe's own date and HH:MM wall-clock time at `now`, comparable with a
// shift's date and startTime (BE-08-T04: which of today's shifts have started).
const cafeClock = async (cafeId, now = new Date()) => {
  const timezone = await getCafeTimezone(cafeId);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return { today: cafeLocalToday(timezone, now), time: `${parts.hour}:${parts.minute}` };
};

module.exports = { DAY_MS, utcDateOnly, cafeToday, cafeClock };
