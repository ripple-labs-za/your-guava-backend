const LeaveRequest = require('../../models/LeaveRequest.model');
const { formatDateOnly } = require('../../utils/timezone');
const { WorkforceError } = require('./errors');

const ACTIVE_STATUSES = Object.freeze(['pending', 'approved']);

// Two requests overlap when each starts on or before the other ends. Rejected
// and cancelled requests never block; approval re-checks against approved ones.
const findOverlappingLeave = ({ cafeId, staffId, start, end, statuses = ACTIVE_STATUSES, excludeId = null, session = null }) =>
  LeaveRequest.findOne({
    cafeId,
    staffId,
    status: { $in: statuses },
    startDate: { $lte: end },
    endDate: { $gte: start },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  })
    .select('type status startDate endDate')
    .session(session)
    .lean();

const leaveOverlapError = (existing, who) =>
  new WorkforceError(
    409,
    'LEAVE_OVERLAP',
    `${who} already has ${existing.status} ${existing.type} leave from ${formatDateOnly(existing.startDate)} to ` +
      `${formatDateOnly(existing.endDate)}. Cancel or reject that request first, or choose dates that do not overlap it.`
  );

module.exports = { ACTIVE_STATUSES, findOverlappingLeave, leaveOverlapError };
