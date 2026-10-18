const Shift = require('../../models/Shift.model');
const Staff = require('../../models/Staff.model');
const LeaveRequest = require('../../models/LeaveRequest.model');
const { formatDateOnly } = require('../../utils/timezone');
const { WorkforceError } = require('./errors');
const { DAY_MS } = require('./cafeCalendar');
const { absoluteSpan } = require('./shiftHours');

// Takes the per-person roster lock and proves the person is active in this
// cafe, in one write. Two shift writes for the same person write-conflict here,
// and withTransaction retries the loser once the winner has committed, so the
// loser's overlap and overtime checks see the winner's shift.
const lockActiveStaff = async ({ cafeId, staffId, session }) => {
  const staff = await Staff.findOneAndUpdate(
    { _id: staffId, cafeId, isActive: true },
    { $inc: { rosterRevision: 1 } },
    { session, new: true, timestamps: false }
  )
    .select('name')
    .lean();
  if (!staff) throw new WorkforceError(404, 'STAFF_NOT_FOUND', 'Staff member not found');
  return staff;
};

// The same lock without the active check: editing or deleting a shift that
// already belongs to someone who has since been deactivated.
const touchStaff = ({ cafeId, staffId, session }) =>
  Staff.updateOne({ _id: staffId, cafeId }, { $inc: { rosterRevision: 1 } }, { session, timestamps: false });

const findOverlappingShift = async ({ cafeId, staffId, date, startTime, endTime, excludeId = null, session = null }) => {
  const target = absoluteSpan(date, startTime, endTime);
  const nearby = await Shift.find({
    cafeId,
    staffId,
    date: { $gte: new Date(date.getTime() - DAY_MS), $lte: new Date(date.getTime() + DAY_MS) },
    status: { $ne: 'cancelled' },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select('date startTime endTime')
    .session(session)
    .lean();
  return (
    nearby.find((shift) => {
      const span = absoluteSpan(shift.date, shift.startTime, shift.endTime);
      return span && span.start < target.end && target.start < span.end;
    }) || null
  );
};

const shiftOverlapError = (overlap) =>
  new WorkforceError(
    409,
    'SHIFT_OVERLAP',
    `This staff member already has a shift from ${overlap.startTime} to ${overlap.endTime} on ${formatDateOnly(overlap.date)}`
  );

const approvedLeaveOn = ({ cafeId, staffId, date, session = null }) =>
  LeaveRequest.findOne({ cafeId, staffId, status: 'approved', startDate: { $lte: date }, endDate: { $gte: date } })
    .select('type startDate endDate')
    .session(session)
    .lean();

const shiftOnLeaveError = (leave) =>
  new WorkforceError(
    409,
    'SHIFT_ON_LEAVE',
    `This staff member is on approved ${leave.type} leave from ${formatDateOnly(leave.startDate)} to ` +
      `${formatDateOnly(leave.endDate)}. Cancel that leave first, or roster someone else.`
  );

module.exports = { lockActiveStaff, touchStaff, findOverlappingShift, shiftOverlapError, approvedLeaveOn, shiftOnLeaveError };
