const mongoose = require('mongoose');
const Staff = require('../../models/Staff.model');
const Shift = require('../../models/Shift.model');
const LeaveRequest = require('../../models/LeaveRequest.model');
const { cafeToday } = require('./cafeCalendar');
const { recomputeStaffWeek, weekStartFor } = require('./shiftHours');

/**
 * Deactivates a person and, in the same transaction, cancels their scheduled
 * shifts from the cafe's today onwards and withdraws their pending leave, so
 * hours, pay and approvals stop including someone who has left. Past shifts
 * and approved leave are records and stay as they are. Returns null when the
 * person is not in this cafe.
 */
const deactivateStaff = async ({ cafeId, staffId, actorUserId }) => {
  const today = await cafeToday(cafeId);
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
        { cafeId, staffId, status: 'scheduled', date: { $gte: today } },
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
