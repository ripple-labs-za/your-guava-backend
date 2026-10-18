const mongoose = require('mongoose');
const LeaveRequest = require('../models/LeaveRequest.model');
const LeaveBalance = require('../models/LeaveBalance.model');
const Staff = require('../models/Staff.model');
const { parseDateOnly, formatDateOnly, inclusiveDateOnlyDays } = require('../utils/timezone');
const { activeCafeId } = require('../utils/tenancy');
const { WorkforceError, sendWorkforceError } = require('../services/workforce/errors');
const {
  WORKFORCE_TEXT_LIMITS, invalid, objectIdString, requiredText, optionalText, dateOnlyInput,
} = require('../services/workforce/input');
const { cafeToday } = require('../services/workforce/cafeCalendar');
const {
  ADJUSTMENTS_KEPT, isCycleType, cycleWindow, cycleTotal, usedDaysInCycle, lockLeaveBalance,
  assertWithinCycle, insufficientBalance, balanceViews, adjustmentView,
} = require('../services/workforce/leaveCycles');

const MAX_LEAVE_SPAN_DAYS = 366;
const MAX_CALENDAR_SPAN_DAYS = 93;
const LEAVE_TYPES = new Set(['annual', 'sick', 'family', 'unpaid']);

/**
 * Count weekdays between two dates (inclusive).
 */
function countWeekdays(start, end) {
  const totalDays = inclusiveDateOnlyDays(start, end);
  const completeWeeks = Math.floor(totalDays / 7);
  let count = completeWeeks * 5;
  const remainingDays = totalDays % 7;
  for (let index = 0; index < remainingDays; index++) {
    const day = (start.getUTCDay() + index) % 7;
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// POST /api/leave — Submit leave request
const create = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const { staffId, type, startDate, endDate, reason } = req.body;

    if (!staffId || !type || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'staffId, type, startDate, and endDate are required',
      });
    }
    if (!LEAVE_TYPES.has(type)) {
      return res.status(400).json({
        success: false,
        message: 'type must be annual, sick, family, or unpaid',
      });
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    if (!start || !end || end < start) {
      return res.status(400).json({ success: false, message: 'startDate and endDate must be a valid YYYY-MM-DD range' });
    }
    if (inclusiveDateOnlyDays(start, end) > MAX_LEAVE_SPAN_DAYS) {
      return res.status(400).json({ success: false, message: `Leave periods cannot exceed ${MAX_LEAVE_SPAN_DAYS} days` });
    }

    const staffMember = await Staff.findOne({ _id: staffId, cafeId }).select('name startDate').lean();
    if (!staffMember) {
      return res.status(404).json({ success: false, code: 'STAFF_NOT_FOUND', message: 'Staff member not found' });
    }

    const days = countWeekdays(start, end); // BE-08-T03 replaces this with the working pattern
    if (days === 0) {
      return res.status(400).json({ success: false, message: 'Leave period must include at least one weekday' });
    }

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
    const { status, staffId } = req.query;

    const filter = { cafeId };
    if (status) filter.status = status;
    if (staffId) filter.staffId = staffId;

    const leaveRequests = await LeaveRequest.find(filter)
      .populate('staffId', 'name role')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, leaveRequests, requests: leaveRequests });
  } catch (error) {
    next(error);
  }
};

// PUT /api/leave/:id/approve — Approve a pending request inside its cycle.
const approve = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = activeCafeId(req);
    const { id } = req.params;
    let leaveRequest;

    await session.withTransaction(async () => {
      leaveRequest = await LeaveRequest.findOne({ _id: id, cafeId }).session(session);
      if (!leaveRequest) throw new WorkforceError(404, 'LEAVE_NOT_FOUND', 'Leave request not found');
      if (leaveRequest.status !== 'pending') {
        throw new WorkforceError(409, 'LEAVE_NOT_PENDING', `Leave request is already ${leaveRequest.status}`);
      }
      const balance = await lockLeaveBalance({ staffId: leaveRequest.staffId, cafeId, session });
      if (!balance) throw new WorkforceError(404, 'LEAVE_BALANCE_NOT_FOUND', 'Leave balance not found');

      if (leaveRequest.type !== 'unpaid') {
        const staff = await Staff.findOne({ _id: leaveRequest.staffId, cafeId }).select('name startDate').session(session).lean();
        if (!staff) throw new WorkforceError(404, 'STAFF_NOT_FOUND', 'Staff member not found');
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
    const { id } = req.params;
    const reason = optionalText((req.body ?? {}).reason, 'reason', WORKFORCE_TEXT_LIMITS.reason);

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
    const { id } = req.params;

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
    next(error);
  }
};

// GET /api/leave/calendar — Approved leave for calendar view
const getCalendar = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      // Default to current month
      const now = new Date();
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    } else {
      startDate = parseDateOnly(startDate);
      endDate = parseDateOnly(endDate);
      if (!startDate || !endDate || endDate < startDate) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate must be a valid YYYY-MM-DD range',
        });
      }
    }
    if (inclusiveDateOnlyDays(startDate, endDate) > MAX_CALENDAR_SPAN_DAYS) {
      return res.status(400).json({
        success: false,
        message: `Calendar ranges cannot exceed ${MAX_CALENDAR_SPAN_DAYS} days`,
      });
    }
    endDate.setUTCHours(23, 59, 59, 999);

    const leaveRequests = await LeaveRequest.find({
      cafeId,
      status: 'approved',
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    })
      .populate('staffId', 'name')
      .lean();

    // Build a map of date -> staff on leave
    const calendar = {};
    for (const lr of leaveRequests) {
      const current = new Date(Math.max(lr.startDate.getTime(), startDate.getTime()));
      const end = new Date(Math.min(lr.endDate.getTime(), endDate.getTime()));
      current.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(0, 0, 0, 0);

      while (current <= end) {
        const day = current.getUTCDay();
        if (day !== 0 && day !== 6) {
          const key = formatDateOnly(current);
          if (!calendar[key]) {
            calendar[key] = { date: key, staff: [] };
          }
          calendar[key].staff.push({
            name: lr.staffId ? lr.staffId.name : 'Unknown',
            type: lr.type,
          });
        }
        current.setUTCDate(current.getUTCDate() + 1);
      }
    }

    return res.status(200).json({ success: true, calendar: Object.values(calendar) });
  } catch (error) {
    next(error);
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
    const body = req.body ?? {};
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
    return res.status(200).json({ success: true, adjustment: adjustmentView(adjustment), balance });
  } catch (error) {
    if (sendWorkforceError(res, error)) return undefined;
    return next(error);
  } finally {
    await session.endSession();
  }
};

module.exports = { create, list, approve, reject, cancel, getCalendar, getBalances, adjustBalance };
