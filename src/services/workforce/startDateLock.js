const Staff = require('../../models/Staff.model');
const LeaveRequest = require('../../models/LeaveRequest.model');
const LeaveBalance = require('../../models/LeaveBalance.model');
const { formatDateOnly } = require('../../utils/timezone');
const { WorkforceError } = require('./errors');
const { CYCLE_TYPES, lockLeaveBalance } = require('./leaveCycles');

/**
 * Leave cycles run from Staff.startDate (D-014). Once approved paid leave or an
 * owner's adjustment is recorded against those cycles, moving the start date
 * would silently re-bucket the leave and orphan the adjustment, so it is
 * refused. Runs inside the caller's transaction and takes the balance lock that
 * approvals and adjustments take, so neither can slip in between the check and
 * the update. Saving the same date again is not a change.
 */
const assertStartDateMovable = async ({ cafeId, staffId, startDate, session }) => {
  const staff = await Staff.findOne({ _id: staffId, cafeId }).select('name startDate').session(session).lean();
  if (!staff || formatDateOnly(staff.startDate) === formatDateOnly(startDate)) return;

  await lockLeaveBalance({ staffId, cafeId, session });
  const approved = await LeaveRequest.exists({ cafeId, staffId, status: 'approved', type: { $in: CYCLE_TYPES } }).session(session);
  const adjusted = await LeaveBalance.exists({ cafeId, staffId, 'adjustments.0': { $exists: true } }).session(session);
  if (!approved && !adjusted) return;

  const recorded = [approved && 'approved leave', adjusted && "an owner's adjustment to a leave total"].filter(Boolean).join(' and ');
  throw new WorkforceError(
    409,
    'STAFF_START_DATE_LOCKED',
    `${staff.name}'s start date stays ${formatDateOnly(staff.startDate)}: ${recorded} is already recorded against the leave ` +
      'cycles that run from it, and a new start date would move that leave into different cycles.' +
      (approved ? ' If the date was entered wrongly, cancel the approved leave first.' : '')
  );
};

module.exports = { assertStartDateMovable };
