const mongoose = require('mongoose');
const Shift = require('../models/Shift.model');
const { formatDateOnly, inclusiveDateOnlyDays, TIME_OF_DAY_RE } = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');
const {
  WORKFORCE_TEXT_LIMITS, invalid, objectIdString, requiredText, optionalText,
  dateOnlyInput, assertPlainBody, parseEnum, SHIFT_STATUSES,
} = require('../services/workforce/input');
const { WorkforceError, sendWorkforceError } = require('../services/workforce/errors');
const { DAY_MS, cafeToday, cafeClock } = require('../services/workforce/cafeCalendar');
const {
  requireShiftSpan, weekStartFor, round2, splitWeekHours, recomputeStaffWeek, shiftHasStarted,
} = require('../services/workforce/shiftHours');
const {
  lockActiveStaff, touchStaff, findOverlappingShift, shiftOverlapError, approvedLeaveOn, shiftOnLeaveError,
} = require('../services/workforce/shiftGuards');

const MAX_SHIFT_RANGE_DAYS = 93;

const timeInput = (value, field) => {
  const time = requiredText(value, field, 5);
  if (!TIME_OF_DAY_RE.test(time)) throw invalid(field, `${field} must use HH:MM`);
  return time;
};

// The requested YYYY-MM-DD range, or the cafe's own current week when neither
// date is sent. One date alone, or a repeated one, is refused (BE-08-T05).
const requestedRange = async ({ query, cafeId, label }) => {
  if (query.startDate === undefined && query.endDate === undefined) {
    const monday = weekStartFor(await cafeToday(cafeId));
    return { start: monday, end: new Date(monday.getTime() + 6 * DAY_MS) };
  }
  const start = dateOnlyInput(query.startDate, 'startDate');
  const end = dateOnlyInput(query.endDate, 'endDate');
  if (end < start) throw invalid('endDate', 'startDate and endDate must be a valid YYYY-MM-DD range');
  if (inclusiveDateOnlyDays(start, end) > MAX_SHIFT_RANGE_DAYS) {
    throw invalid('endDate', `${label} ranges cannot exceed ${MAX_SHIFT_RANGE_DAYS} days`);
  }
  return { start, end };
};

const fail = (res, next, error) => (sendWorkforceError(res, error) ? undefined : next(error));

// POST /api/shifts — Create a shift. The person's roster lock serialises
// concurrent writes, so the overlap check and the insert act as one; overtime
// is then recomputed for the whole calendar week (BE-08-T04).
const create = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const body = assertPlainBody(req.body);
    const staffId = objectIdString(body.staffId, 'staffId');
    const shiftDate = dateOnlyInput(body.date, 'date');
    const startTime = timeInput(body.startTime, 'startTime');
    const endTime = timeInput(body.endTime, 'endTime');
    const status = body.status === undefined ? undefined : parseEnum(body.status, SHIFT_STATUSES, 'status');
    const notes = optionalText(body.notes, 'notes', WORKFORCE_TEXT_LIMITS.notes);
    const span = requireShiftSpan(startTime, endTime);

    let shiftId;
    await session.withTransaction(async () => {
      await lockActiveStaff({ cafeId, staffId, session });
      if (status !== 'cancelled') {
        const leave = await approvedLeaveOn({ cafeId, staffId, date: shiftDate, session });
        if (leave) throw shiftOnLeaveError(leave);
        const overlap = await findOverlappingShift({ cafeId, staffId, date: shiftDate, startTime, endTime, session });
        if (overlap) throw shiftOverlapError(overlap);
      }
      const [shift] = await Shift.create(
        [{ cafeId, staffId, date: shiftDate, startTime, endTime, hoursWorked: span.hours, endsNextDay: span.endsNextDay, status, notes }],
        { session }
      );
      shiftId = shift._id;
      await recomputeStaffWeek({ cafeId, staffId, weekStart: weekStartFor(shiftDate), session });
    });

    const shift = await Shift.findOne({ _id: shiftId, cafeId }).lean();
    return res.status(201).json({ success: true, shift });
  } catch (error) {
    return fail(res, next, error);
  } finally {
    await session.endSession();
  }
};

// GET /api/shifts — Shifts in a date range; cancelled ones only with
// ?includeCancelled=true, so the roster never renders them as real.
const list = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const range = await requestedRange({ query: req.query, cafeId, label: 'Shift' });
    const shifts = await Shift.find({
      cafeId,
      date: { $gte: range.start, $lte: range.end },
      ...(req.query.includeCancelled === 'true' ? {} : { status: { $ne: 'cancelled' } }),
    })
      .populate('staffId', 'name role')
      .sort({ date: 1, startTime: 1 })
      .lean();

    return res.status(200).json({ success: true, shifts });
  } catch (error) {
    return fail(res, next, error);
  }
};

// GET /api/shifts/week — The cafe's current week, grouped by day
const getWeek = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const monday = weekStartFor(await cafeToday(cafeId));
    const sunday = new Date(monday.getTime() + 6 * DAY_MS);

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: monday, $lte: sunday },
      status: { $ne: 'cancelled' },
    })
      // Pay data is owner-only; staff reads already hide it from managers, and
      // populating it here reopened the same leak through the roster.
      .populate('staffId', req.user.role === 'owner' ? 'name role hourlyRate' : 'name role')
      .sort({ date: 1, startTime: 1 })
      .lean();

    // Group by day
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const roster = {};
    for (let i = 0; i < 7; i++) {
      const key = formatDateOnly(new Date(monday.getTime() + i * DAY_MS));
      roster[key] = { day: days[i], date: key, shifts: [] };
    }

    for (const shift of shifts) {
      const key = formatDateOnly(shift.date);
      if (roster[key]) {
        roster[key].shifts.push(shift);
      }
    }

    return res.status(200).json({ success: true, roster: Object.values(roster) });
  } catch (error) {
    return fail(res, next, error);
  }
};

// GET /api/shifts/summary — hours per person. Each shift's overtime is counted
// against its own Monday-to-Sunday week, so the query widens to whole weeks and
// then reports only the shifts inside the requested range.
const getSummary = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const range = await requestedRange({ query: req.query, cafeId, label: 'Summary' });
    const from = weekStartFor(range.start);
    const to = new Date(weekStartFor(range.end).getTime() + 7 * DAY_MS);
    const shifts = await Shift.find({ cafeId, date: { $gte: from, $lt: to }, status: { $ne: 'cancelled' } })
      .populate('staffId', 'name hourlyRate')
      .lean();

    const weeks = shifts
      .filter((shift) => shift.staffId)
      .reduce((groups, shift) => {
        const key = `${shift.staffId._id}:${weekStartFor(shift.date).getTime()}`;
        return groups.set(key, [...(groups.get(key) || []), shift]);
      }, new Map());

    const inRange = (shift) => shift.date >= range.start && shift.date <= range.end;
    const totals = [...weeks.values()]
      .flatMap((weekShifts) => splitWeekHours(weekShifts))
      .filter(({ shift }) => inRange(shift))
      .reduce((byStaff, { shift, regularHours, overtimeHours }) => {
        const sid = String(shift.staffId._id);
        const prev = byStaff.get(sid) || {
          staffId: sid, staffName: shift.staffId.name, hourlyRate: shift.staffId.hourlyRate,
          totalHours: 0, regularHours: 0, overtimeHours: 0,
        };
        return byStaff.set(sid, {
          ...prev,
          totalHours: prev.totalHours + Number(shift.hoursWorked || 0),
          regularHours: prev.regularHours + regularHours,
          overtimeHours: prev.overtimeHours + overtimeHours,
        });
      }, new Map());

    // estimatedPay is the rate multiplied out, so both stay owner-only.
    const canSeePay = req.user.role === 'owner';
    const summary = [...totals.values()]
      .sort((a, b) => a.staffName.localeCompare(b.staffName))
      .map(({ hourlyRate, ...s }) => ({
        ...s,
        ...(canSeePay ? { hourlyRate } : {}),
        totalHours: round2(s.totalHours),
        regularHours: round2(s.regularHours),
        overtimeHours: round2(s.overtimeHours),
        ...(canSeePay ? { estimatedPay: round2(s.regularHours * hourlyRate + s.overtimeHours * hourlyRate * 1.5) } : {}),
        // BCEA's 45 hours are per calendar week: true when any week in the range went over.
        overThreshold: s.overtimeHours > 0,
      }));

    return res.status(200).json({ success: true, summary, summaries: summary });
  } catch (error) {
    return fail(res, next, error);
  }
};

// PUT /api/shifts/:id — Update a shift; both the old and the new week are recomputed.
const update = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');
    const body = assertPlainBody(req.body);
    const staffId = body.staffId === undefined ? undefined : objectIdString(body.staffId, 'staffId');
    const date = body.date === undefined ? undefined : dateOnlyInput(body.date, 'date');
    const startTime = body.startTime === undefined ? undefined : timeInput(body.startTime, 'startTime');
    const endTime = body.endTime === undefined ? undefined : timeInput(body.endTime, 'endTime');
    const status = body.status === undefined ? undefined : parseEnum(body.status, SHIFT_STATUSES, 'status');
    const notes = optionalText(body.notes, 'notes', WORKFORCE_TEXT_LIMITS.notes);
    const clock = status === 'completed' ? await cafeClock(cafeId) : null;

    await session.withTransaction(async () => {
      const existing = await Shift.findOne({ _id: id, cafeId }).session(session).lean();
      if (!existing) throw new WorkforceError(404, 'SHIFT_NOT_FOUND', 'Shift not found');
      const target = {
        staffId: staffId ?? existing.staffId,
        date: date ?? existing.date,
        startTime: startTime ?? existing.startTime,
        endTime: endTime ?? existing.endTime,
        status: status ?? existing.status,
      };
      const span = requireShiftSpan(target.startTime, target.endTime);
      const movesPerson = String(target.staffId) !== String(existing.staffId);

      // A shift that stays on the roster needs an active person, so a deactivated
      // person's cancelled shift cannot be brought back or moved; a cancel or a
      // note alone is bookkeeping and only takes their roster lock (BE-08-T04 review).
      const onlyNotes = [staffId, date, startTime, endTime, status].every((value) => value === undefined);
      // Marking a started shift completed is bookkeeping too: final pay for someone
      // who has left depends on it (Orchy ruling). Same started rule as deactivation.
      const completesStarted = clock !== null
        && [staffId, date, startTime, endTime].every((value) => value === undefined)
        && shiftHasStarted(existing, clock);
      const needsActive = movesPerson || (target.status !== 'cancelled' && !onlyNotes && !completesStarted);
      if (needsActive) await lockActiveStaff({ cafeId, staffId: target.staffId, session });
      if (movesPerson || !needsActive) await touchStaff({ cafeId, staffId: existing.staffId, session });
      if (target.status !== 'cancelled') {
        const leave = await approvedLeaveOn({ cafeId, staffId: target.staffId, date: target.date, session });
        if (leave) throw shiftOnLeaveError(leave);
        const overlap = await findOverlappingShift({ cafeId, ...target, excludeId: existing._id, session });
        if (overlap) throw shiftOverlapError(overlap);
      }
      await Shift.updateOne(
        { _id: existing._id, cafeId },
        {
          $set: {
            ...target,
            ...(notes !== undefined && { notes }),
            hoursWorked: span.hours,
            endsNextDay: span.endsNextDay,
          },
        },
        { session, runValidators: true }
      );
      await recomputeStaffWeek({ cafeId, staffId: existing.staffId, weekStart: weekStartFor(existing.date), session });
      if (movesPerson || weekStartFor(target.date).getTime() !== weekStartFor(existing.date).getTime()) {
        await recomputeStaffWeek({ cafeId, staffId: target.staffId, weekStart: weekStartFor(target.date), session });
      }
    });

    const shift = await Shift.findOne({ _id: id, cafeId }).lean();
    return res.status(200).json({ success: true, shift });
  } catch (error) {
    return fail(res, next, error);
  } finally {
    await session.endSession();
  }
};

// DELETE /api/shifts/:id — Delete a shift and recompute the rest of its week.
const remove = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');
    let found = false;
    await session.withTransaction(async () => {
      const shift = await Shift.findOne({ _id: id, cafeId }).session(session).lean();
      found = Boolean(shift);
      if (!shift) return;
      await touchStaff({ cafeId, staffId: shift.staffId, session });
      await Shift.deleteOne({ _id: shift._id, cafeId }, { session });
      await recomputeStaffWeek({ cafeId, staffId: shift.staffId, weekStart: weekStartFor(shift.date), session });
    });
    if (!found) return res.status(404).json({ success: false, code: 'SHIFT_NOT_FOUND', message: 'Shift not found' });
    return res.status(200).json({ success: true, message: 'Shift deleted' });
  } catch (error) {
    return fail(res, next, error);
  } finally {
    await session.endSession();
  }
};

module.exports = { create, list, getWeek, getSummary, update, remove };
