/**
 * Re-export barrel (BE-11-T03). Invitations, members, ownership, cafes and the
 * access audit each live in ./team/*. team.routes.js imports this path.
 */
const {
  inviteManager, previewInvitation, acceptInvitation, resendInvitation, revokeInvitation,
} = require('./team/invitations');
const { listTeam, removeMember, updateMember } = require('./team/members');
const { listAccessAudit } = require('./team/audit');
const { transferOwnership } = require('./team/ownership');
const { switchCafe, addCafe, archiveCafe, restoreCafe } = require('./team/cafes');

module.exports = {
  inviteManager,
  listTeam,
  listAccessAudit,
  previewInvitation,
  acceptInvitation,
  resendInvitation,
  revokeInvitation,
  removeMember,
  updateMember,
  transferOwnership,
  switchCafe,
  addCafe,
  archiveCafe,
  restoreCafe,
};
