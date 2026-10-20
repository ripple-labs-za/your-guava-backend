const logger = require('../../utils/logger');
// POST /team/transfer-ownership.
// Moved from team.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const User = require('../../models/User.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const TeamInvitation = require('../../models/TeamInvitation.model');
const AuthSession = require('../../models/AuthSession.model');
const emailService = require('../../services/email.service');
const { passwordTooLong } = require('../../utils/password');
const { recordAccessAudit } = require('./audit');
const { clearRefreshCookie } = require('../../utils/authPrimitives');
const { refusalBody } = require('../../utils/errorCodes');

// POST /api/team/transfer-ownership - Atomically make one manager the sole owner.
const transferOwnership = async (req, res, next) => {
  let session;
  try {
    const { userId, currentPassword } = req.body || {};
    if (!mongoose.isValidObjectId(userId) || String(userId) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'Select a manager to become the owner' });
    }
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({ success: false, message: 'Current password is required' });
    }
    // The code tells the portal this 401 is an answer, not an expired session it should refresh (FB-043).
    if (passwordTooLong(currentPassword)) {
      return res.status(401).json({ success: false, code: 'CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' });
    }

    let target;
    let handoff;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const currentOwner = await User.findOne({
        _id: req.user.id,
        orgId: req.user.orgId,
        role: 'owner',
      }).select('+password').session(session);
      if (!currentOwner || !(await currentOwner.comparePassword(currentPassword))) {
        const error = new Error('Current password is incorrect');
        error.statusCode = 401;
        error.code = 'CURRENT_PASSWORD_INCORRECT';
        throw error;
      }
      target = await User.findOne({
        _id: userId,
        orgId: req.user.orgId,
        role: 'manager',
      }).session(session);
      if (!target) {
        const error = new Error('Manager not found');
        error.statusCode = 404;
        throw error;
      }
      const org = await Organization.findOneAndUpdate(
        { _id: req.user.orgId, ownerId: currentOwner._id },
        { $set: { ownerId: target._id, updatedAt: new Date() } },
        { new: true, session }
      );
      if (!org) {
        const error = new Error('Ownership changed. Refresh and try again.');
        error.statusCode = 409;
        throw error;
      }
      const cafes = await Cafe.find({ orgId: org._id, archivedAt: null }).select('_id').session(session);
      const allCafeIds = cafes.map((cafe) => cafe._id);
      if (allCafeIds.length === 0) {
        const error = new Error('An organization must have at least one cafe');
        error.statusCode = 409;
        throw error;
      }

      currentOwner.role = 'manager';
      currentOwner.permissions = { canSpendCredits: false };
      currentOwner.cafeIds = allCafeIds;
      if (!allCafeIds.map(String).includes(String(currentOwner.activeCafeId))) {
        currentOwner.activeCafeId = allCafeIds[0];
      }
      currentOwner.tokenVersion = Number(currentOwner.tokenVersion || 0) + 1;

      target.role = 'owner';
      target.cafeIds = allCafeIds;
      if (!allCafeIds.map(String).includes(String(target.activeCafeId))) {
        target.activeCafeId = allCafeIds[0];
      }
      target.tokenVersion = Number(target.tokenVersion || 0) + 1;
      await currentOwner.save({ session });
      await target.save({ session });
      handoff = {
        orgName: org.name,
        previous: { email: currentOwner.email, name: currentOwner.name },
        next: { email: target.email, name: target.name },
      };
      // Pending and expired invitations remain manageable after ownership
      // changes. Their capability tokens are organization-bound, and preview /
      // acceptance validates the current owner against invitedByUserId.
      const reassignedInvitations = await TeamInvitation.updateMany(
        {
          orgId: org._id,
          invitedByUserId: currentOwner._id,
          status: { $in: ['pending', 'expired'] },
        },
        { $set: { invitedByUserId: target._id } },
        { session }
      );
      await AuthSession.updateMany(
        { userId: { $in: [currentOwner._id, target._id] }, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'ownership_transfer' } },
        { session }
      );
      await recordAccessAudit({
        orgId: org._id,
        actorUserId: currentOwner._id,
        targetUserId: target._id,
        action: 'ownership.transferred',
        targetEmail: target.email,
        details: {
          previousOwnerId: currentOwner._id,
          newOwnerId: target._id,
          invitationsReassigned: reassignedInvitations.modifiedCount,
        },
        requestId: req.id,
        session,
      });
    });

    // identity-16: both people hear about the transfer; a failed notice never fails the transfer.
    if (handoff) {
      const warn = (who) => (error) => logger.warn('ownership_notice_failed', { who, ...logger.errorFields(error) });
      emailService.sendSecurityNoticeEmail({
        kind: 'ownership_transferred_away', user: handoff.previous, orgName: handoff.orgName, counterpartName: handoff.next.name,
      }).catch(warn('previous owner'));
      emailService.sendSecurityNoticeEmail({
        kind: 'ownership_received', user: handoff.next, orgName: handoff.orgName, counterpartName: handoff.previous.name,
      }).catch(warn('new owner'));
    }

    clearRefreshCookie(res);
    return res.status(200).json({
      success: true,
      message: `${target.name} is now the account owner. Both users must sign in again.`,
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json(refusalBody(error));
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  transferOwnership,
};
