const mongoose = require('mongoose');
const LeaveRequest = require('../models/LeaveRequest.model');
const LeaveBalance = require('../models/LeaveBalance.model');
const Staff = require('../models/Staff.model');
const { formatDateOnly, inclusiveDateOnlyDays } = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');
const { WorkforceError, sendWorkforceError } = require('../services/workforce/errors');
const {
  WORKFORCE_TEXT_LIMITS, invalid, objectIdString, requiredText, optionalText, dateOnlyInput,
  assertPlainBody, parseEnum, LEAVE_TYPES, LEAVE_STATUSES,
} = require('../services/workforce/input');
const { cafeToday } = require('../services/workforce/cafeCalendar');
const {
  ADJUSTMENTS_KEPT, isCycleType, cycleWindow, cycleTotal, usedDaysInCycle, lockLeaveBalance,
  assertWithinCycle, insufficientBalance, balanceViews, adjustmentView,
} = require('../services/workforce/leaveCycles');
const { leaveDayBreakdown, describeWorkPattern } = require('../services/workforce/workingDays');
const { findOverlappingLeave, leaveOverlapError } = require('../services/workforce/leaveOverlap');
const { touchStaff, rosteredShiftsBetween, leaveHasShiftsError } = require('../services/workforce/shiftGuards');

const MAX_LEAVE_SPAN_DAYS = 366;
const MAX_CALENDAR_SPAN_DAYS = 93;

// POST /api/leave — Submit leave request
const create = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const body = assertPlainBody(req.body);
    const staffId = objectIdString(body.staffId, 'staffId');
    const type = parseEnum(body.type, LEAVE_TYPES, 'type');
    const start = dateOnlyInput(body.startDate, 'startDate');
    const end = dateOnlyInput(body.endDate, 'endDate');
    const reason = optionalText(body.reason, 'reason', WORKFORCE_TEXT_LIMITS.reason);
    if (end < start) throw invalid('endDate', 'startDate and endDate must be a valid YYYY-MM-DD range');
    if (inclusiveDateOnlyDays(start, end) > MAX_LEAVE_SPAN_DAYS) {
      throw invalid('endDate', `Leave periods cannot exceed ${MAX_LEAVE_SPAN_DAYS} days`);
    }

    const staffMember = await Staff.findOne({ _id: staffId, cafeId, isActive: true }).select('name startDate workDays').lean();
    if (!staffMember) {
      return res.status(404).json({ success: false, code: 'STAFF_NOT_FOUND', message: 'Staff member not found' });
    }

    const { days } = leaveDayBreakdown(start, end, staffMember.workDays);
    if (days === 0) {
      throw new WorkforceError(
        400,
        'LEAVE_NO_WORKING_DAYS',
        `${formatDateOnly(start)} to ${formatDateOnly(end)} has none of ${staffMember.name}'s working days ` +
          `(${describeWorkPattern(staffMember.workDays)}) outside public holidays, so there is nothing to record.`
      );
    }

    const overlap = await findOverlappingLeave({ cafeId, staffId, start, end });
    if (overlap) throw leaveOverlapError(overlap, staffMember.name);

    if (type !== 'unpaid') {
      const balance = await LeaveBalance.findOne({ staffId, cafeId }).lean();
      if (!balance) {
        return res.status(404).json({ success: false, code: 'LEAVE_BALANCE_NOT_FOUND', message: 'Leave balance not found for staff member' });
      }
      const window = cycleWindow(type, staffMember.startDate, start);
      assertWithinCycle({ window, end, staffName: staffMember.name });
      const remaining = cycleTotal(balance, type, window.start) - (await usedDaysInCycle({ cafeId, staffId, type, window }));
      if (days > remaining) throw insufficientBalance({ window, remaining, days });
    }

    const leaveRequest = await LeaveRequest.create({
      staffId,
      cafeId,
      type,
      startDate: start,
      endDate: end,
      days,
      reason,
    });

    return res.status(201).json({ success: true, leaveRequest });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/leave — List all leave requests
const list = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const staffId = req.query.staffId === undefined ? undefined : objectIdString(req.query.staffId, 'staffId');
    const status = req.query.status === undefined ? undefined : parseEnum(req.query.status, LEAVE_STATUSES, 'status');

    const filter = { cafeId };
    if (status) filter.status = status;
    if (staffId) filter.staffId = staffId;

    const leaveRequests = await LeaveRequest.find(filter)
      .populate('staffId', 'name role')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, leaveRequests, requests: leaveRequests });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// PUT /api/leave/:id/approve — Approve a pending request inside its cycle.
const approve = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');
    let leaveRequest;

    await session.withTransaction(async () => {
      leaveRequest = await LeaveRequest.findOne({ _id: id, cafeId }).session(session);
      if (!leaveRequest) throw new WorkforceError(404, 'LEAVE_NOT_FOUND', 'Leave request not found');
      if (leaveRequest.status !== 'pending') {
        throw new WorkforceError(409, 'LEAVE_NOT_PENDING', `Leave request is already ${leaveRequest.status}`);
      }
      const balance = await lockLeaveBalance({ staffId: leaveRequest.staffId, cafeId, session });
      if (!balance) throw new WorkforceError(404, 'LEAVE_BALANCE_NOT_FOUND', 'Leave balance not found');
      const clash = await findOverlappingLeave({
        cafeId,
        staffId: leaveRequest.staffId,
        start: leaveRequest.startDate,
        end: leaveRequest.endDate,
        statuses: ['approved'],
        excludeId: leaveRequest._id,
        session,
      });
      if (clash) throw leaveOverlapError(clash, 'This staff member');
      // Active staff only, for every type: no request of someone who has left is approved (BE-08-T04).
      const staff = await Staff.findOne({ _id: leaveRequest.staffId, cafeId, isActive: true })
        .select('name startDate')
        .session(session)
        .lean();
      if (!staff) throw new WorkforceError(404, 'STAFF_NOT_FOUND', 'Staff member not found');
      // The roster lock as well as the balance lock: a shift created for these days
      // at the same moment write-conflicts here instead of slipping past the check.
      await touchStaff({ cafeId, staffId: leaveRequest.staffId, session });
      const rostered = await rosteredShiftsBetween({
        cafeId, staffId: leaveRequest.staffId, start: leaveRequest.startDate, end: leaveRequest.endDate, session,
      });
      if (rostered.length > 0) throw leaveHasShiftsError(rostered, staff.name);

      if (leaveRequest.type !== 'unpaid') {
        const window = cycleWindow(leaveRequest.type, staff.startDate, leaveRequest.startDate);
        assertWithinCycle({ window, end: leaveRequest.endDate, staffName: staff.name });
        const used = await usedDaysInCycle({ cafeId, staffId: leaveRequest.staffId, type: leaveRequest.type, window, session });
        const remaining = cycleTotal(balance, leaveRequest.type, window.start) - used;
        if (leaveRequest.days > remaining) throw insufficientBalance({ window, remaining, days: leaveRequest.days });
      }

      leaveRequest.status = 'approved';
      leaveRequest.approvedBy = req.user.id;
      leaveRequest.approvedAt = new Date();
      await leaveRequest.save({ session });
    });

    return res.status(200).json({ success: true, leaveRequest });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  } finally {
    await session.endSession();
  }
};

// PUT /api/leave/:id/cancel — The owner withdraws a pending or approved request.
// Used days are derived from approved requests, so an approved request's days
// return to its cycle the moment its status leaves 'approved'.
const cancel = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');
    const reason = optionalText(assertPlainBody(req.body).reason, 'reason', WORKFORCE_TEXT_LIMITS.reason);

    const leaveRequest = await LeaveRequest.findOneAndUpdate(
      { _id: id, cafeId, status: { $in: ['pending', 'approved'] } },
      {
        $set: {
          status: 'cancelled',
          cancelledBy: req.user.id,
          cancelledAt: new Date(),
          ...(reason ? { cancelReason: reason } : {}),
        },
      },
      { new: true, runValidators: true }
    );
    if (!leaveRequest) {
      const existing = await LeaveRequest.findOne({ _id: id, cafeId }).select('status').lean();
      if (!existing) throw new WorkforceError(404, 'LEAVE_NOT_FOUND', 'Leave request not found');
      throw new WorkforceError(409, 'LEAVE_NOT_CANCELLABLE', `Leave request is already ${existing.status}, so it cannot be cancelled`);
    }
    return res.status(200).json({ success: true, leaveRequest });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// PUT /api/leave/:id/reject — Reject leave request
const reject = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const id = objectIdString(req.params.id, 'id');

    const leaveRequest = await LeaveRequest.findOneAndUpdate(
      { _id: id, cafeId, status: 'pending' },
      { $set: { status: 'rejected' } },
      { new: true }
    );
    if (!leaveRequest) {
      const existing = await LeaveRequest.findOne({ _id: id, cafeId }).select('status').lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Leave request not found' });
      return res.status(409).json({ success: false, message: `Leave request is already ${existing.status}` });
    }

    return res.status(200).json({ success: true, leaveRequest });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/leave/calendar — who is away on each day: every day of the person's
// working pattern inside approved leave, weekends and public holidays included.
const getCalendar = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    let range;
    if (req.query.startDate === undefined && req.query.endDate === undefined) {
      const today = await cafeToday(cafeId);
      range = {
        start: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
        end: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)),
      };
    } else {
      const start = dateOnlyInput(req.query.startDate, 'startDate');
      const end = dateOnlyInput(req.query.endDate, 'endDate');
      if (!start || !end || end < start) {
        throw invalid('endDate', 'startDate and endDate must be a valid YYYY-MM-DD range');
      }
      range = { start, end };
    }
    if (inclusiveDateOnlyDays(range.start, range.end) > MAX_CALENDAR_SPAN_DAYS) {
      throw invalid('endDate', `Calendar ranges cannot exceed ${MAX_CALENDAR_SPAN_DAYS} days`);
    }

    const leaveRequests = await LeaveRequest.find({
      cafeId,
      status: 'approved',
      startDate: { $lte: range.end },
      endDate: { $gte: range.start },
    })
      .populate('staffId', 'name workDays')
      .sort({ startDate: 1 })
      .lean();

    const byDate = leaveRequests.reduce((days, lr) => {
      const from = new Date(Math.max(lr.startDate.getTime(), range.start.getTime()));
      const to = new Date(Math.min(lr.endDate.getTime(), range.end.getTime()));
      const { chargedDates, holidayDates } = leaveDayBreakdown(from, to, lr.staffId?.workDays);
      const entry = { name: lr.staffId ? lr.staffId.name : 'Unknown', type: lr.type };
      for (const key of [...chargedDates, ...holidayDates.map((holiday) => holiday.date)]) {
        days.set(key, { date: key, staff: [...(days.get(key)?.staff || []), entry] });
      }
      return days;
    }, new Map());

    const calendar = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return res.status(200).json({ success: true, calendar });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// GET /api/leave/balances?onDate=YYYY-MM-DD — each active person's balance in
// the cycle containing onDate (default: the cafe's today).
const getBalances = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const onDate = req.query.onDate === undefined ? await cafeToday(cafeId) : dateOnlyInput(req.query.onDate, 'onDate');
    const staff = await Staff.find({ cafeId, isActive: true }).select('name role isActive startDate').sort({ name: 1 }).lean();
    const balances = await LeaveBalance.find({ cafeId, staffId: { $in: staff.map((member) => member._id) } }).lean();
    const views = await balanceViews({ cafeId, staff, balances, onDate, includeAdjustments: req.user.role === 'owner' });
    return res.status(200).json({ success: true, onDate: formatDateOnly(onDate), balances: views.filter(Boolean) });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  }
};

// PUT /api/leave/balances/:staffId — The owner sets one cycle's total, with a
// reason. The entry stays on the balance as the audit record (D-014).
const adjustBalance = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const staffId = objectIdString(req.params.staffId, 'staffId');
    const body = assertPlainBody(req.body);
    if (!isCycleType(body.type)) throw invalid('type', 'type must be annual, sick or family');
    const { total } = body;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > 366 || !Number.isInteger(total * 2)) {
      throw invalid('total', 'total must be a number of days from 0 to 366, in whole or half days');
    }
    const reason = requiredText(body.reason, 'reason', WORKFORCE_TEXT_LIMITS.reason);
    const onDate = body.onDate === undefined ? await cafeToday(cafeId) : dateOnlyInput(body.onDate, 'onDate');

    let adjustment;
    await session.withTransaction(async () => {
      const staff = await Staff.findOne({ _id: staffId, cafeId }).select('startDate').session(session).lean();
      if (!staff) throw new WorkforceError(404, 'STAFF_NOT_FOUND', 'Staff member not found');
      const balance = await lockLeaveBalance({ staffId, cafeId, session });
      if (!balance) throw new WorkforceError(404, 'LEAVE_BALANCE_NOT_FOUND', 'Leave balance not found for staff member');
      const window = cycleWindow(body.type, staff.startDate, onDate);
      adjustment = {
        type: body.type,
        cycleStart: window.start,
        previousTotal: cycleTotal(balance, body.type, window.start),
        total,
        reason,
        byUserId: req.user.id,
        at: new Date(),
      };
      await LeaveBalance.updateOne(
        { _id: balance._id },
        { $push: { adjustments: { $each: [adjustment], $slice: -ADJUSTMENTS_KEPT } } },
        { session, runValidators: true }
      );
    });

    const member = await Staff.findOne({ _id: staffId, cafeId }).select('name role isActive startDate').lean();
    const balances = await LeaveBalance.find({ staffId, cafeId }).lean();
    const [balance] = await balanceViews({ cafeId, staff: [member], balances, onDate, includeAdjustments: true });
    // Allowed (the owner corrects by hand), but never silent: the form shows this.
    const { used } = balance[body.type];
    const warning = used > total
      ? `${used} days already taken in this cycle exceed the new total of ${total}, so the balance shows ${total - used} ` +
        'until leave is cancelled or the total is raised.'
      : undefined;
    return res.status(200).json({ success: true, adjustment: adjustmentView(adjustment), balance, ...(warning ? { warning } : {}) });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  } finally {
    await session.endSession();
  }
};

module.exports = { create, list, approve, reject, cancel, getCalendar, getBalances, adjustBalance };
