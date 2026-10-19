const mongoose = require('mongoose');
const Staff = require('../../models/Staff.model');
const Shift = require('../../models/Shift.model');
const LeaveRequest = require('../../models/LeaveRequest.model');
const { cafeClock } = require('./cafeCalendar');
const { recomputeStaffWeek, weekStartFor, notStartedFilter } = require('./shiftHours');

/**
 * Deactivates a person and, in the same transaction, cancels their scheduled
 * shifts that have not started yet (later dates, and today's with a start
 * time still ahead on the cafe's clock) and withdraws their pending leave, so
 * hours, pay and approvals stop including someone who has left. A shift
 * already under way or worked earlier today is kept for pay, as are past
 * shifts and approved leave. Returns null when the person is not in this cafe.
 */
const deactivateStaff = async ({ cafeId, staffId, actorUserId, now = new Date() }) => {
  const clock = await cafeClock(cafeId, now);
  const { today } = clock;
  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      const staff = await Staff.findOneAndUpdate(
        { _id: staffId, cafeId },
        { $set: { isActive: false }, $inc: { rosterRevision: 1 } },
        { session, new: true }
      );
      if (!staff) {
        result = null;
        return;
      }
      const shifts = await Shift.updateMany(
        // HH:MM strings compare in clock order; a shift starting this minute has started.
        { cafeId, staffId, status: 'scheduled', ...notStartedFilter(clock) },
        { $set: { status: 'cancelled', regularHours: 0, overtimeHours: 0, type: 'regular' } },
        { session }
      );
      const leave = await LeaveRequest.updateMany(
        { cafeId, staffId, status: 'pending' },
        { $set: { status: 'cancelled', cancelledBy: actorUserId, cancelledAt: new Date(), cancelReason: 'Staff member deactivated' } },
        { session }
      );
      await recomputeStaffWeek({ cafeId, staffId, weekStart: weekStartFor(today), session });
      result = { staff, cancelledShifts: shifts.modifiedCount, cancelledLeaveRequests: leave.modifiedCount };
    });
    return result;
  } finally {
    await session.endSession();
  }
};

module.exports = { deactivateStaff };
