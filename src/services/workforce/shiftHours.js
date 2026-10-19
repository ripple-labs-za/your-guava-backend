const Shift = require('../../models/Shift.model');
const { cafeLocalToday } = require('../../utils/timezone');
const { WorkforceError } = require('./errors');
const { DAY_MS, utcDateOnly } = require('./cafeCalendar');

const WEEKLY_HOUR_THRESHOLD = 45; // BCEA: 45 ordinary hours in a week
const MAX_SHIFT_HOURS = 16; // guards against an AM/PM slip becoming a 23-hour overnight shift
const MINUTES_PER_DAY = 1440;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const toMinutes = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * A shift's span in minutes from midnight of its own date. An end time
 * before the start time means the shift finishes the next day (22:00-02:00,
 * 16:00-00:00). Equal times are refused: 0 h and 24 h are both likelier
 * typos than shifts.
 */
// Hours are wall-clock: a shift across a DST change would be off by an hour (ISSUES #90; SAST has no DST).
const shiftSpan = (startTime, endTime) => {
  if (typeof startTime !== 'string' || typeof endTime !== 'string') return null;
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return null;
  const start = toMinutes(startTime);
  const rawEnd = toMinutes(endTime);
  if (rawEnd === start) return null;
  const endsNextDay = rawEnd < start;
  const end = endsNextDay ? rawEnd + MINUTES_PER_DAY : rawEnd;
  return { start, end, endsNextDay, hours: (end - start) / 60 };
};

const requireShiftSpan = (startTime, endTime) => {
  const span = shiftSpan(startTime, endTime);
  if (!span) {
    throw new WorkforceError(
      400,
      'INVALID_SHIFT_TIMES',
      'startTime and endTime must use HH:MM and differ; an end time before the start time means the next day'
    );
  }
  if (span.hours > MAX_SHIFT_HOURS) {
    throw new WorkforceError(400, 'INVALID_SHIFT_TIMES', `A shift can be at most ${MAX_SHIFT_HOURS} hours`);
  }
  return span;
};

// The same span on one timeline (minutes since the epoch), so shifts on
// neighbouring dates compare: Monday 22:00-02:00 overlaps Tuesday 01:00-05:00.
const absoluteSpan = (date, startTime, endTime) => {
  const span = shiftSpan(startTime, endTime);
  if (!span) return null;
  const base = Math.round(utcDateOnly(date).getTime() / 60000);
  return { start: base + span.start, end: base + span.end };
};

// 00:00 UTC on the Monday of the Monday-to-Sunday week containing a date-only value.
const weekStartFor = (date) => {
  const day = utcDateOnly(date);
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
};

// The cafe's current week, from the cafe's own calendar date at `instant`.
const localWeekBounds = (instant, timezone) => {
  const monday = weekStartFor(cafeLocalToday(timezone, instant));
  return { monday, sunday: new Date(monday.getTime() + 6 * DAY_MS) };
};

// One rule for "this shift has started", given the cafe's clock ({ today, time }
// from cafeClock): its date is before today, or it is today and its HH:MM start
// has come. The query form selects the shifts that have NOT started. Deactivation
// and the bookkeeping on a deactivated person's shifts both use these (BE-08-T04).
const shiftHasStarted = (shift, clock) => {
  const day = utcDateOnly(shift.date).getTime();
  const today = clock.today.getTime();
  return day < today || (day === today && shift.startTime <= clock.time);
};
const notStartedFilter = (clock) => ({
  $or: [{ date: { $gt: clock.today } }, { date: clock.today, startTime: { $gt: clock.time } }],
});

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Splits one person's non-cancelled shifts in one calendar week into regular
 * and overtime hours in the order they are worked: the first 45 hours of the
 * week are regular, whatever order the shifts were entered in.
 */
const splitWeekHours = (shifts) =>
  [...shifts]
    .sort((a, b) => utcDateOnly(a.date) - utcDateOnly(b.date) || toMinutes(a.startTime) - toMinutes(b.startTime))
    .reduce(
      ({ before, rows }, shift) => {
        const hours = Number(shift.hoursWorked || 0);
        const regularHours = round2(Math.min(hours, Math.max(0, WEEKLY_HOUR_THRESHOLD - before)));
        const overtimeHours = round2(hours - regularHours);
        const type = overtimeHours > 0 ? 'overtime' : 'regular';
        return { before: before + hours, rows: [...rows, { shift, regularHours, overtimeHours, type }] };
      },
      { before: 0, rows: [] }
    ).rows;

/**
 * Rewrites regularHours, overtimeHours and type on every shift of one person's
 * week, inside the caller's transaction. Called after every create, update,
 * delete and deactivation, so the stored flags always agree with /summary.
 */
const recomputeStaffWeek = async ({ cafeId, staffId, weekStart, session }) => {
  const date = { $gte: weekStart, $lt: new Date(weekStart.getTime() + 7 * DAY_MS) };
  const shifts = await Shift.find({ cafeId, staffId, date, status: { $ne: 'cancelled' } })
    .select('date startTime hoursWorked')
    .session(session)
    .lean();
  const rows = splitWeekHours(shifts);
  if (rows.length > 0) {
    await Shift.bulkWrite(
      rows.map(({ shift, regularHours, overtimeHours, type }) => ({
        updateOne: { filter: { _id: shift._id, cafeId }, update: { $set: { regularHours, overtimeHours, type } } },
      })),
      { session }
    );
  }
  await Shift.updateMany(
    { cafeId, staffId, date, status: 'cancelled' },
    { $set: { regularHours: 0, overtimeHours: 0, type: 'regular' } },
    { session }
  );
};

module.exports = {
  WEEKLY_HOUR_THRESHOLD,
  MAX_SHIFT_HOURS,
  shiftSpan,
  requireShiftSpan,
  absoluteSpan,
  weekStartFor,
  localWeekBounds,
  shiftHasStarted,
  notStartedFilter,
  round2,
  splitWeekHours,
  recomputeStaffWeek,
};
