const Shift = require('../models/Shift.model');
const Staff = require('../models/Staff.model');
const { formatDateOnly, inclusiveDateOnlyDays, TIME_OF_DAY_RE } = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');
const {
  WORKFORCE_TEXT_LIMITS, invalid, objectIdString, requiredText, optionalText,
  dateOnlyInput, assertPlainBody, parseEnum, SHIFT_STATUSES,
} = require('../services/workforce/input');
const { sendWorkforceError } = require('../services/workforce/errors');

const WEEKLY_HOUR_THRESHOLD = 45; // South African BCEA law
const MAX_SHIFT_RANGE_DAYS = 93;

const timeInput = (value, field) => {
  const time = requiredText(value, field, 5);
  if (!TIME_OF_DAY_RE.test(time)) throw invalid(field, `${field} must use HH:MM`);
  return time;
};

/**
 * Calculate hours between two HH:MM time strings.
 */
function calcHours(startTime, endTime) {
  if (!TIME_OF_DAY_RE.test(String(startTime || '')) || !TIME_OF_DAY_RE.test(String(endTime || ''))) {
    return NaN;
  }
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  return ((eh * 60 + em) - (sh * 60 + sm)) / 60;
}

/**
 * Get Monday 00:00 and Sunday 23:59 for the week containing the given date.
 */
function getWeekBounds(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  return { monday, sunday };
}

/**
 * Get total hours for a staff member in the week containing the given date,
 * excluding a specific shift id (for updates).
 */
/**
 * Returns true if the staff member exists and belongs to the given cafe.
 * Prevents attaching shifts/leave to another tenant's staff.
 */
async function staffBelongsToCafe(staffId, cafeId) {
  const staff = await Staff.findOne({ _id: staffId, cafeId }).select('_id').lean();
  return Boolean(staff);
}

const toMinutes = (time) => {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
};

/**
 * Finds a non-cancelled shift for the same staff member on the same day whose
 * time range overlaps [startTime, endTime). Touching ranges (one ends exactly
 * when the other starts) are not an overlap. excludeShiftId skips the shift
 * being updated so a shift never conflicts with itself.
 */
async function findOverlappingShift(cafeId, staffId, date, startTime, endTime, excludeShiftId = null) {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayStart.getUTCDate() + 1);

  const filter = {
    cafeId,
    staffId,
    date: { $gte: dayStart, $lt: dayEnd },
    status: { $ne: 'cancelled' },
  };
  if (excludeShiftId) {
    filter._id = { $ne: excludeShiftId };
  }
  const sameDay = await Shift.find(filter).select('startTime endTime').lean();
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  return sameDay.find((s) => toMinutes(s.startTime) < end && start < toMinutes(s.endTime)) || null;
}

const shiftOverlapResponse = (res, overlap, date) =>
  res.status(409).json({
    success: false,
    code: 'SHIFT_OVERLAP',
    message: `This staff member already has a shift from ${overlap.startTime} to ${overlap.endTime} on ${formatDateOnly(date)}`,
  });

async function getWeeklyHours(cafeId, staffId, date, excludeShiftId = null) {
  const { monday, sunday } = getWeekBounds(date);
  const filter = {
    cafeId,
    staffId,
    date: { $gte: monday, $lte: sunday },
    status: { $ne: 'cancelled' },
  };
  if (excludeShiftId) {
    filter._id = { $ne: excludeShiftId };
  }
  const shifts = await Shift.find(filter).lean();
  return shifts.reduce((sum, s) => sum + (s.hoursWorked || 0), 0);
}

// POST /api/shifts — Create a shift
const create = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const body = assertPlainBody(req.body);
    const staffId = objectIdString(body.staffId, 'staffId');
    const shiftDate = dateOnlyInput(body.date, 'date');
    const startTime = timeInput(body.startTime, 'startTime');
    const endTime = timeInput(body.endTime, 'endTime');
    const status = body.status === undefined ? undefined : parseEnum(body.status, SHIFT_STATUSES, 'status');
    const notes = optionalText(body.notes, 'notes', WORKFORCE_TEXT_LIMITS.notes);

    const hoursWorked = calcHours(startTime, endTime);
    if (!Number.isFinite(hoursWorked) || hoursWorked <= 0 || hoursWorked > 24) {
      throw invalid('endTime', 'endTime must be after startTime and both times must use HH:MM');
    }

    if (!(await staffBelongsToCafe(staffId, cafeId))) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    const overlap = await findOverlappingShift(cafeId, staffId, shiftDate, startTime, endTime);
    if (overlap) {
      return shiftOverlapResponse(res, overlap, shiftDate);
    }

    // Check if weekly total exceeds 45hrs — auto-flag overtime
    const existingWeeklyHours = await getWeeklyHours(cafeId, staffId, shiftDate);
    const regularHours = Math.min(hoursWorked, Math.max(0, WEEKLY_HOUR_THRESHOLD - existingWeeklyHours));
    const overtimeHours = Math.max(0, hoursWorked - regularHours);
    const type = overtimeHours > 0 ? 'overtime' : 'regular';

    const shift = await Shift.create({
      cafeId,
      staffId,
      date: shiftDate,
      startTime,
      endTime,
      hoursWorked,
      regularHours,
      overtimeHours,
      type,
      status,
      notes,
    });

    return res.status(201).json({ success: true, shift });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/shifts — Get shifts for a date range
const list = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    let { startDate, endDate } = req.query;

    // Default to current week Mon-Sun
    if (startDate === undefined && endDate === undefined) {
      const { monday, sunday } = getWeekBounds(new Date());
      startDate = monday;
      endDate = sunday;
    } else {
      startDate = dateOnlyInput(startDate, 'startDate');
      endDate = dateOnlyInput(endDate, 'endDate');
      if (!startDate || !endDate || endDate < startDate) {
        throw invalid('endDate', 'startDate and endDate must be a valid YYYY-MM-DD range');
      }
      if (inclusiveDateOnlyDays(startDate, endDate) > MAX_SHIFT_RANGE_DAYS) {
        throw invalid('endDate', `Shift ranges cannot exceed ${MAX_SHIFT_RANGE_DAYS} days`);
      }
      endDate.setUTCHours(23, 59, 59, 999);
    }

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: startDate, $lte: endDate },
    })
      .populate('staffId', 'name role')
      .sort({ date: 1, startTime: 1 })
      .lean();

    return res.status(200).json({ success: true, shifts });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/shifts/week — Current week's roster grouped by day
const getWeek = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { monday, sunday } = getWeekBounds(new Date());

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
      const dayDate = new Date(monday);
      dayDate.setUTCDate(monday.getUTCDate() + i);
      const key = formatDateOnly(dayDate);
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
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/shifts/summary — Weekly hours summary per staff member
const getSummary = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    let { startDate, endDate } = req.query;

    if (startDate === undefined && endDate === undefined) {
      const { monday, sunday } = getWeekBounds(new Date());
      startDate = monday;
      endDate = sunday;
    } else {
      startDate = dateOnlyInput(startDate, 'startDate');
      endDate = dateOnlyInput(endDate, 'endDate');
      if (!startDate || !endDate || endDate < startDate) {
        throw invalid('endDate', 'startDate and endDate must be a valid YYYY-MM-DD range');
      }
      if (inclusiveDateOnlyDays(startDate, endDate) > MAX_SHIFT_RANGE_DAYS) {
        throw invalid('endDate', `Summary ranges cannot exceed ${MAX_SHIFT_RANGE_DAYS} days`);
      }
      endDate.setUTCHours(23, 59, 59, 999);
    }

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: startDate, $lte: endDate },
      status: { $ne: 'cancelled' },
    })
      .populate('staffId', 'name hourlyRate')
      .sort({ staffId: 1, date: 1, startTime: 1 })
      .lean();

    // Aggregate by staff
    const staffMap = {};
    const weeklyHours = {};
    for (const shift of shifts) {
      if (!shift.staffId) continue;
      const sid = shift.staffId._id.toString();
      if (!staffMap[sid]) {
        staffMap[sid] = {
          staffId: sid,
          staffName: shift.staffId.name,
          hourlyRate: shift.staffId.hourlyRate,
          totalHours: 0,
          regularHours: 0,
          overtimeHours: 0,
        };
      }
      const hours = Number(shift.hoursWorked || 0);
      const weekKey = `${sid}:${formatDateOnly(getWeekBounds(shift.date).monday)}`;
      const hoursBeforeShift = weeklyHours[weekKey] || 0;
      const regularHours = Math.min(hours, Math.max(0, WEEKLY_HOUR_THRESHOLD - hoursBeforeShift));
      const overtimeHours = Math.max(0, hours - regularHours);
      weeklyHours[weekKey] = hoursBeforeShift + hours;
      staffMap[sid].totalHours += hours;
      staffMap[sid].regularHours += regularHours;
      staffMap[sid].overtimeHours += overtimeHours;
    }

    // estimatedPay is the rate multiplied out, so it is as sensitive as the
    // rate itself: both leave the payload for anyone who is not the owner.
    const canSeePay = req.user.role === 'owner';
    const summary = Object.values(staffMap).map(({ hourlyRate, ...s }) => ({
      ...s,
      ...(canSeePay ? { hourlyRate } : {}),
      totalHours: Math.round(s.totalHours * 100) / 100,
      regularHours: Math.round(s.regularHours * 100) / 100,
      overtimeHours: Math.round(s.overtimeHours * 100) / 100,
      ...(canSeePay
        ? {
          estimatedPay:
            Math.round(
              (s.regularHours * hourlyRate + s.overtimeHours * hourlyRate * 1.5) * 100
            ) / 100,
        }
        : {}),
      overThreshold: s.totalHours > WEEKLY_HOUR_THRESHOLD,
    }));

    return res.status(200).json({ success: true, summary, summaries: summary });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// PUT /api/shifts/:id — Update shift
const update = async (req, res, next) => {
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

    const existing = await Shift.findOne({ _id: id, cafeId });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    const newStartTime = startTime ?? existing.startTime;
    const newEndTime = endTime ?? existing.endTime;
    const newDate = date ?? existing.date;
    const newStaffId = staffId ?? existing.staffId;
    const hoursWorked = calcHours(newStartTime, newEndTime);
    if (!Number.isFinite(hoursWorked) || hoursWorked <= 0 || hoursWorked > 24) {
      throw invalid('endTime', 'endTime must be after startTime and both times must use HH:MM');
    }

    if (staffId && !(await staffBelongsToCafe(staffId, cafeId))) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    const overlap = await findOverlappingShift(
      cafeId,
      newStaffId,
      newDate,
      newStartTime,
      newEndTime,
      existing._id
    );
    if (overlap) {
      return shiftOverlapResponse(res, overlap, newDate);
    }

    // Re-check overtime threshold
    const existingWeeklyHours = await getWeeklyHours(cafeId, newStaffId, newDate, existing._id);
    const regularHours = Math.min(hoursWorked, Math.max(0, WEEKLY_HOUR_THRESHOLD - existingWeeklyHours));
    const overtimeHours = Math.max(0, hoursWorked - regularHours);
    const type = overtimeHours > 0 ? 'overtime' : 'regular';

    const shift = await Shift.findOneAndUpdate(
      { _id: id, cafeId },
      {
        $set: {
          ...(staffId !== undefined && { staffId }),
          ...(date !== undefined && { date: newDate }),
          ...(startTime !== undefined && { startTime }),
          ...(endTime !== undefined && { endTime }),
          ...(status !== undefined && { status }),
          ...(notes !== undefined && { notes }),
          hoursWorked,
          regularHours,
          overtimeHours,
          type,
        },
      },
      { new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, shift });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// DELETE /api/shifts/:id — Delete shift
const remove = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');

    const shift = await Shift.findOneAndDelete({ _id: id, cafeId });

    if (!shift) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    return res.status(200).json({ success: true, message: 'Shift deleted' });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

module.exports = { create, list, getWeek, getSummary, update, remove };
