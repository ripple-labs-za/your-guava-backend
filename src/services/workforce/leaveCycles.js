const LeaveRequest = require('../../models/LeaveRequest.model');
const LeaveBalance = require('../../models/LeaveBalance.model');
const { formatDateOnly } = require('../../utils/timezone');
const { WorkforceError } = require('./errors');
const { DAY_MS, utcDateOnly } = require('./cafeCalendar');

// BCEA defaults for a five-day week (D-014): annual leave 15 working days per
// 12-month cycle, sick leave 30 days per 36-month cycle, family responsibility
// leave 3 days per annual cycle. Every cycle runs from Staff.startDate.
const LEAVE_CYCLE_RULES = Object.freeze({
  annual: Object.freeze({ months: 12, defaultTotal: 15 }),
  sick: Object.freeze({ months: 36, defaultTotal: 30 }),
  family: Object.freeze({ months: 12, defaultTotal: 3 }),
});
const CYCLE_TYPES = Object.freeze(Object.keys(LEAVE_CYCLE_RULES));
const ADJUSTMENTS_KEPT = 500;
const ADJUSTMENTS_SHOWN = 20;

const isCycleType = (type) => typeof type === 'string' && Object.hasOwn(LEAVE_CYCLE_RULES, type);

// The same day of the month N months later; the 29th to 31st clamp to the last day.
const addMonthsUtc = (date, months) => {
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), lastDay)));
};

/**
 * The cycle of `type` containing `onDate` for someone employed from
 * `employmentStart`. A date before the recorded start belongs to the first
 * cycle with no lower bound (countsFrom null): Staff.startDate defaults to
 * the day the record was created, and an owner may log an earlier absence.
 */
const cycleWindow = (type, employmentStart, onDate) => {
  if (!isCycleType(type)) return null;
  const { months } = LEAVE_CYCLE_RULES[type];
  const start = utcDateOnly(employmentStart || onDate);
  const day = utcDateOnly(onDate);
  const monthsApart = (day.getUTCFullYear() - start.getUTCFullYear()) * 12 + (day.getUTCMonth() - start.getUTCMonth());
  const guess = Math.max(0, Math.floor(monthsApart / months));
  const index = guess > 0 && addMonthsUtc(start, guess * months) > day ? guess - 1 : guess;
  const cycleStart = addMonthsUtc(start, index * months);
  const nextStart = addMonthsUtc(start, (index + 1) * months);
  return Object.freeze({
    type,
    index,
    start: cycleStart,
    end: new Date(nextStart.getTime() - DAY_MS),
    nextStart,
    countsFrom: index === 0 ? null : cycleStart,
  });
};

// The one rule for "in this cycle": a request is charged to the cycle that
// contains its start date. The approval gate and the balance views both use it.
const inCycle = (date, window) => {
  const time = new Date(date).getTime();
  return time <= window.end.getTime() && (window.countsFrom === null || time >= window.countsFrom.getTime());
};

const daysInCycle = (requests, window) =>
  requests
    .filter((request) => request.type === window.type && inCycle(request.startDate, window))
    .reduce((sum, request) => sum + (request.days || 0), 0);

// The owner's latest adjustment for this cycle, else the stored per-cycle default.
const cycleTotal = (balance, type, cycleStart) => {
  const key = new Date(cycleStart).getTime();
  const latest = (balance?.adjustments || [])
    .filter((entry) => entry.type === type && new Date(entry.cycleStart).getTime() === key)
    .reduce((best, entry) => (!best || new Date(entry.at) >= new Date(best.at) ? entry : best), null);
  if (latest) return latest.total;
  const stored = balance?.[type]?.total;
  return Number.isFinite(stored) ? stored : LEAVE_CYCLE_RULES[type].defaultTotal;
};

// A person's approved leave of one type is a handful of rows a year, so the
// cycle is chosen by inCycle rather than by a second copy of the rule in a query.
const usedDaysInCycle = async ({ cafeId, staffId, type, window, session = null }) => {
  const rows = await LeaveRequest.find({ cafeId, staffId, type, status: 'approved' })
    .select('type startDate days')
    .session(session)
    .lean();
  return daysInCycle(rows, window);
};

// Every write that depends on a person's balance takes this first, inside its
// transaction. Two transactions that increment the same document write-conflict,
// and withTransaction retries the loser, which then sees the winner's commit.
const lockLeaveBalance = ({ staffId, cafeId, session }) =>
  LeaveBalance.findOneAndUpdate({ staffId, cafeId }, { $inc: { revision: 1 } }, { session, new: true, timestamps: false }).lean();

const assertWithinCycle = ({ window, end, staffName }) => {
  if (!window || new Date(end).getTime() <= window.end.getTime()) return;
  throw new WorkforceError(
    400,
    'LEAVE_CROSSES_CYCLE',
    `This ${window.type} leave runs past ${staffName}'s leave cycle, which ends on ${formatDateOnly(window.end)}. ` +
      `Submit it as two requests: one ending ${formatDateOnly(window.end)}, and one starting ${formatDateOnly(window.nextStart)}.`
  );
};

const insufficientBalance = ({ window, remaining, days }) =>
  new WorkforceError(
    400,
    'LEAVE_INSUFFICIENT_BALANCE',
    `Insufficient ${window.type} leave balance. ${remaining} day(s) remaining in the cycle ` +
      `${formatDateOnly(window.start)} to ${formatDateOnly(window.end)}, ${days} requested.`
  );

const cycleBalance = (balance, window, used) => {
  const total = cycleTotal(balance, window.type, window.start);
  return { total, used, remaining: total - used, cycleStart: formatDateOnly(window.start), cycleEnd: formatDateOnly(window.end) };
};

const adjustmentView = (entry) => ({
  type: entry.type,
  cycleStart: formatDateOnly(new Date(entry.cycleStart)),
  previousTotal: entry.previousTotal,
  total: entry.total,
  reason: entry.reason,
  byUserId: String(entry.byUserId),
  at: new Date(entry.at).toISOString(),
});

/**
 * Balance views for `staff` as of `onDate`, with one query for all their
 * approved leave. The result is aligned with `staff`; an entry is null when
 * that person has no LeaveBalance document.
 */
const balanceViews = async ({ cafeId, staff, balances, onDate, includeAdjustments = false }) => {
  if (staff.length === 0) return [];
  const balanceByStaff = new Map(balances.map((balance) => [String(balance.staffId?._id ?? balance.staffId), balance]));
  const approved = await LeaveRequest.find({
    cafeId,
    staffId: { $in: staff.map((member) => member._id) },
    status: 'approved',
    type: { $in: CYCLE_TYPES },
  })
    .select('staffId type startDate days')
    .lean();

  return staff.map((member) => {
    const id = String(member._id);
    const balance = balanceByStaff.get(id);
    if (!balance) return null;
    const mine = approved.filter((request) => String(request.staffId) === id);
    const perType = CYCLE_TYPES.map((type) => {
      const window = cycleWindow(type, member.startDate, onDate);
      return [type, cycleBalance(balance, window, daysInCycle(mine, window))];
    });
    const adjustments = includeAdjustments
      ? [...(balance.adjustments || [])]
          .sort((a, b) => new Date(b.at) - new Date(a.at))
          .slice(0, ADJUSTMENTS_SHOWN)
          .map(adjustmentView)
      : null;
    return {
      staffId: id,
      staff: { _id: id, name: member.name, role: member.role, isActive: member.isActive },
      ...Object.fromEntries(perType),
      ...(adjustments ? { adjustments } : {}),
    };
  });
};

module.exports = {
  LEAVE_CYCLE_RULES,
  CYCLE_TYPES,
  ADJUSTMENTS_KEPT,
  isCycleType,
  addMonthsUtc,
  cycleWindow,
  cycleTotal,
  usedDaysInCycle,
  lockLeaveBalance,
  assertWithinCycle,
  insufficientBalance,
  balanceViews,
  adjustmentView,
};
