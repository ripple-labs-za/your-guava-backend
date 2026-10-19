const logger = require('../../utils/logger');
// Invitations: create, preview, accept, resend and revoke, with the TTL and token helpers.
// Moved from team.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const User = require('../../models/User.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const TeamInvitation = require('../../models/TeamInvitation.model');
const { getPlan } = require('../../services/billingPlans.service');
const emailService = require('../../services/email.service');
const { isValidEmail } = require('../../utils/email');
const { passwordInputError } = require('../../utils/password');
const { recordAccessAudit } = require('./audit');
const { refusalBody } = require('../../utils/errorCodes');
const { generateOpaqueToken, sha256Hex, normalizedOpaqueToken } = require('../../utils/authPrimitives');
const { normalizeCafeIds, expirePendingInvitations, validateCafeAccess, buildSeatSummary } = require('./members');

const DEFAULT_INVITE_TTL_HOURS = 48;
const MIN_INVITE_TTL_HOURS = 1;
const MAX_INVITE_TTL_HOURS = 168;
const INVALID_INVITATION_MESSAGE = 'This invitation is invalid or has expired';

const inviteTtlMs = () => {
  const configured = Number.parseInt(process.env.TEAM_INVITE_TTL_HOURS, 10);
  const hours = Number.isFinite(configured)
    ? Math.max(MIN_INVITE_TTL_HOURS, Math.min(MAX_INVITE_TTL_HOURS, configured))
    : DEFAULT_INVITE_TTL_HOURS;
  return hours * 60 * 60 * 1000;
};


const invitationError = (statusCode = 404, message = INVALID_INVITATION_MESSAGE) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isInvitationError = true;
  return error;
};

const invitationDto = (invitation) => ({
  id: invitation._id,
  _id: invitation._id,
  email: invitation.email,
  name: invitation.name,
  cafeIds: invitation.cafeIds,
  permissions: {
    canSpendCredits: Boolean(invitation.permissions?.canSpendCredits),
  },
  status: invitation.status,
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
});

// POST /api/team/invite - Owner sends a single-use manager invitation.
const inviteManager = async (req, res, next) => {
  let session;
  try {
    const { email, name, cafeIds, canSpendCredits = false } = req.body;

    const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const submittedCafeIds = Array.isArray(cafeIds) ? cafeIds.map(String) : [];
    const requestedCafeIds = normalizeCafeIds(cafeIds);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }
    if (normalizedName.length < 2 || normalizedName.length > 120) {
      return res.status(400).json({ success: false, message: 'Name must be between 2 and 120 characters' });
    }
    if (
      requestedCafeIds.length === 0 ||
      requestedCafeIds.length !== new Set(submittedCafeIds).size
    ) {
      return res.status(400).json({ success: false, message: 'Select valid cafe access' });
    }
    if (typeof canSpendCredits !== 'boolean') {
      return res.status(400).json({ success: false, message: 'canSpendCredits must be a boolean' });
    }

    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can add team members' });
    }

    const invitationToken = generateOpaqueToken();
    const tokenHash = sha256Hex(invitationToken);
    let invitation;
    let validCafeIds;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Touching the organization serializes quota decisions for this tenant.
      // Concurrent invites then conflict and retry against the committed count.
      const org = await Organization.findOneAndUpdate(
        { _id: owner.orgId },
        { $set: { updatedAt: new Date() }, $inc: { __v: 1 } },
        { new: true, session }
      );
      if (!org) {
        const error = new Error('Organization not found');
        error.statusCode = 404;
        throw error;
      }

      await expirePendingInvitations(owner.orgId, session);

      const existingInvitation = await TeamInvitation.findOne({
        orgId: owner.orgId,
        email: normalizedEmail,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      if (existingInvitation) {
        const error = new Error('An invitation is already pending for this email');
        error.statusCode = 409;
        throw error;
      }

      validCafeIds = await validateCafeAccess(owner.orgId, requestedCafeIds, session);
      if (validCafeIds.length !== requestedCafeIds.length) {
        const error = new Error('Select valid cafe access');
        error.statusCode = 400;
        throw error;
      }

      const activeSeats = await User.countDocuments({ orgId: owner.orgId }).session(session);
      const pendingSeats = await TeamInvitation.countDocuments({
        orgId: owner.orgId,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      const used = activeSeats + pendingSeats;
      const plan = getPlan(org.plan);
      if (used >= plan.includedSeats) {
        const error = new Error(
          `Seat limit reached on the ${plan.id} plan. Upgrade your plan or remove a member.`
        );
        error.statusCode = 402;
        error.seats = {
          plan: plan.id,
          used,
          active: activeSeats,
          pending: pendingSeats,
          included: plan.includedSeats,
          remaining: 0,
        };
        throw error;
      }

      // Identity-4: checked last, after cafe access and seats, and answered without naming the reason.
      const existing = await User.findOne({ email: normalizedEmail }).select('_id').session(session);
      if (existing) {
        const error = new Error('This email address cannot be invited. Check it, or ask the person for a different address.');
        error.statusCode = 409;
        error.code = 'INVITE_NOT_POSSIBLE';
        throw error;
      }

      [invitation] = await TeamInvitation.create([{
        email: normalizedEmail,
        name: normalizedName,
        orgId: owner.orgId,
        invitedByUserId: owner._id,
        cafeIds: validCafeIds,
        permissions: { canSpendCredits },
        tokenHash,
        expiresAt: new Date(Date.now() + inviteTtlMs()),
      }], { session });
      await recordAccessAudit({
        orgId: owner.orgId,
        actorUserId: owner._id,
        action: 'invitation.created',
        targetEmail: normalizedEmail,
        details: { invitationId: invitation._id, cafeIds: validCafeIds, canSpendCredits },
        requestId: req.id,
        session,
      });
    });

    const assignedCafes = await Cafe.find({
      _id: { $in: validCafeIds },
      orgId: owner.orgId,
    }).select('name').lean();
    let emailResult;
    try {
      emailResult = await emailService.sendTeamInviteEmail({
        invitation,
        owner,
        cafes: assignedCafes,
        invitationToken,
      });
    } catch (emailErr) {
      emailResult = { sent: false, error: emailErr };
    }

    if (!emailService.deliveryAccepted(emailResult)) {
      // A failed delivery must not reserve a seat or leave a usable token behind.
      await TeamInvitation.updateOne(
        { _id: invitation._id, status: 'pending', tokenHash },
        { $set: { status: 'revoked', revokedAt: new Date() } }
      );
      const updatedSeats = await buildSeatSummary(owner.orgId);
      const providerMissing = emailResult?.skipped;
      const errorMessage = providerMissing
        ? 'Team invite email is not configured. Configure email delivery before inviting members.'
        : 'Team invite email could not be sent. No usable invitation remains.';

      if (providerMissing) {
        logger.warn('invitation_email_unconfigured', { invitationId: String(invitation._id) });
      } else {
        logger.error('invitation_email_failed', { invitationId: String(invitation._id), errorMessage: emailResult?.error?.message });
      }

      return res.status(providerMissing ? 503 : 502).json({
        success: false,
        message: errorMessage,
        emailSent: false,
        seats: updatedSeats,
      });
    }

    const updatedSeats = await buildSeatSummary(owner.orgId);

    return res.status(201).json({
      success: true,
      invitation: invitationDto(invitation),
      seats: updatedSeats,
      emailSent: emailResult.sent === true,
      deliveryMode: emailService.deliveryMode(),
    });
  } catch (error) {
    if (error?.statusCode === 402 && error?.seats) {
      return res.status(402).json({
        success: false,
        message: error.message,
        seats: error.seats,
      });
    }
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An invitation is already pending for this email',
      });
    }
    if (error?.code === 'INVITE_NOT_POSSIBLE') {
      return res.status(409).json(refusalBody(error));
    }
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// POST /api/team/invitations/preview - Public capability-token lookup.
const previewInvitation = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedOpaqueToken(req.body?.token);
    if (!token) throw invitationError();

    const invitation = await TeamInvitation.findOne({
      tokenHash: sha256Hex(token),
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!invitation) throw invitationError();

    const [org, cafes] = await Promise.all([
      Organization.findById(invitation.orgId).select('name ownerId').lean(),
      Cafe.find({
        _id: { $in: invitation.cafeIds },
        orgId: invitation.orgId,
      }).select('name').lean(),
    ]);
    if (
      !org ||
      String(org.ownerId) !== String(invitation.invitedByUserId) ||
      cafes.length !== invitation.cafeIds.length
    ) {
      throw invitationError();
    }

    return res.status(200).json({
      success: true,
      invitation: {
        email: invitation.email,
        name: invitation.name,
        organizationName: org.name,
        cafeNames: cafes.map((cafe) => cafe.name),
        role: 'manager',
        canSpendCredits: Boolean(invitation.permissions?.canSpendCredits),
        expiresAt: invitation.expiresAt,
      },
    });
  } catch (error) {
    if (error?.isInvitationError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return next(error);
  }
};

// POST /api/team/invitations/accept - Sets the manager's password exactly once.
const acceptInvitation = async (req, res, next) => {
  let session;
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedOpaqueToken(req.body?.token);
    const password = req.body?.password;
    if (!token) throw invitationError();
    const passwordError = passwordInputError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, message: passwordError });
    }

    const tokenHash = sha256Hex(token);
    let manager;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Read the capability first, then take the organization lock before
      // mutating it. Resend and invite use the same lock order, avoiding a
      // lock inversion while still re-checking the token atomically below.
      const candidate = await TeamInvitation.findOne(
        {
          tokenHash,
          status: 'pending',
          expiresAt: { $gt: new Date() },
        }
      ).session(session);
      if (!candidate) throw invitationError();

      // Serializing on the organization makes concurrent seat acceptance exact.
      const org = await Organization.findOneAndUpdate(
        { _id: candidate.orgId, ownerId: candidate.invitedByUserId },
        {
          $set: { updatedAt: new Date() },
          $inc: { __v: 1 },
        },
        { new: true, session }
      );
      if (!org) throw invitationError();

      const invitation = await TeamInvitation.findOneAndUpdate(
        {
          _id: candidate._id,
          tokenHash,
          status: 'pending',
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'accepting' } },
        { new: true, session }
      );
      if (!invitation) throw invitationError();

      const owner = await User.findOne({
        _id: invitation.invitedByUserId,
        orgId: invitation.orgId,
        role: 'owner',
      }).session(session);
      if (!owner) throw invitationError();

      const requestedCafeIds = invitation.cafeIds.map(String);
      const validCafeIds = await validateCafeAccess(invitation.orgId, requestedCafeIds, session);
      if (validCafeIds.length === 0 || validCafeIds.length !== requestedCafeIds.length) {
        throw invitationError(409, 'This invitation cannot be accepted. Ask the account owner for a new invitation.');
      }

      const activeSeats = await User.countDocuments({ orgId: invitation.orgId }).session(session);
      if (activeSeats >= getPlan(org.plan).includedSeats) {
        throw invitationError(409, 'This invitation cannot be accepted. Ask the account owner for a new invitation.');
      }

      const existing = await User.findOne({ email: invitation.email }).session(session);
      if (existing) {
        throw invitationError(409, 'This invitation cannot be accepted. Ask the account owner for a new invitation.');
      }

      [manager] = await User.create([{
        email: invitation.email,
        name: invitation.name,
        password,
        role: 'manager',
        emailVerified: true,
        emailVerifiedAt: new Date(),
        permissions: {
          canSpendCredits: Boolean(invitation.permissions?.canSpendCredits),
        },
        orgId: invitation.orgId,
        cafeIds: validCafeIds,
        activeCafeId: validCafeIds[0],
      }], { session });

      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      await invitation.save({ session });
      await recordAccessAudit({
        orgId: invitation.orgId,
        actorUserId: manager._id,
        targetUserId: manager._id,
        action: 'invitation.accepted',
        targetEmail: manager.email,
        details: {
          invitationId: invitation._id,
          cafeIds: validCafeIds,
          canSpendCredits: Boolean(invitation.permissions?.canSpendCredits),
        },
        requestId: req.id,
        session,
      });
    });

    return res.status(201).json({
      success: true,
      message: 'Invitation accepted. You can now sign in.',
      user: { email: manager.email },
    });
  } catch (error) {
    if (error?.isInvitationError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This invitation cannot be accepted. Ask the account owner for a new invitation.',
      });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// POST /api/team/invitations/:invitationId/resend - Rotate the token and expiry.
const resendInvitation = async (req, res, next) => {
  let session;
  try {
    if (!mongoose.isValidObjectId(req.params.invitationId)) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }
    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can resend invitations' });
    }

    const invitationToken = generateOpaqueToken();
    const tokenHash = sha256Hex(invitationToken);
    let invitation;
    let validCafeIds;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const org = await Organization.findOneAndUpdate(
        { _id: owner.orgId, ownerId: owner._id },
        { $set: { updatedAt: new Date() }, $inc: { __v: 1 } },
        { new: true, session }
      );
      if (!org) throw invitationError(404, 'Invitation not found');

      await expirePendingInvitations(owner.orgId, session);
      invitation = await TeamInvitation.findOne({
        _id: req.params.invitationId,
        orgId: owner.orgId,
        status: { $in: ['pending', 'expired'] },
      }).select('+tokenHash').session(session);
      if (!invitation) throw invitationError(404, 'Invitation not found');

      const existing = await User.findOne({ email: invitation.email }).session(session);
      if (existing) throw invitationError(409, 'An account already exists for this email');

      const requestedCafeIds = invitation.cafeIds.map(String);
      validCafeIds = await validateCafeAccess(owner.orgId, requestedCafeIds, session);
      if (validCafeIds.length === 0 || validCafeIds.length !== requestedCafeIds.length) {
        throw invitationError(409, 'Update this invitation with valid cafe access before resending');
      }

      const activeSeats = await User.countDocuments({ orgId: owner.orgId }).session(session);
      const pendingSeats = await TeamInvitation.countDocuments({
        _id: { $ne: invitation._id },
        orgId: owner.orgId,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      const used = activeSeats + pendingSeats;
      const plan = getPlan(org.plan);
      if (used >= plan.includedSeats) {
        const error = new Error(`Seat limit reached on the ${plan.id} plan`);
        error.statusCode = 402;
        throw error;
      }

      invitation.tokenHash = tokenHash;
      invitation.status = 'pending';
      invitation.expiresAt = new Date(Date.now() + inviteTtlMs());
      invitation.revokedAt = undefined;
      invitation.acceptedAt = undefined;
      await invitation.save({ session });
      await recordAccessAudit({
        orgId: owner.orgId,
        actorUserId: owner._id,
        action: 'invitation.resent',
        targetEmail: invitation.email,
        details: { invitationId: invitation._id, cafeIds: validCafeIds },
        requestId: req.id,
        session,
      });
    });

    const assignedCafes = await Cafe.find({
      _id: { $in: validCafeIds },
      orgId: owner.orgId,
    }).select('name').lean();
    let emailResult;
    try {
      emailResult = await emailService.sendTeamInviteEmail({
        invitation,
        owner,
        cafes: assignedCafes,
        invitationToken,
      });
    } catch (emailErr) {
      emailResult = { sent: false, error: emailErr };
    }

    if (!emailService.deliveryAccepted(emailResult)) {
      await TeamInvitation.updateOne(
        { _id: invitation._id, status: 'pending', tokenHash },
        { $set: { status: 'revoked', revokedAt: new Date() } }
      );
      return res.status(emailResult?.skipped ? 503 : 502).json({
        success: false,
        message: emailResult?.skipped
          ? 'Team invite email is not configured. Configure email delivery before resending.'
          : 'Team invite email could not be sent. The invitation was revoked.',
        seats: await buildSeatSummary(owner.orgId),
      });
    }

    return res.status(200).json({
      success: true,
      invitation: invitationDto(invitation),
      seats: await buildSeatSummary(owner.orgId),
      emailSent: emailResult.sent === true,
      deliveryMode: emailService.deliveryMode(),
    });
  } catch (error) {
    if (error?.isInvitationError || (error?.statusCode && error.statusCode < 500)) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'An invitation is already pending for this email' });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// DELETE /api/team/invitations/:invitationId - Revoke an unused invite token.
const revokeInvitation = async (req, res, next) => {
  let session;
  try {
    if (!mongoose.isValidObjectId(req.params.invitationId)) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }
    let invitation;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      invitation = await TeamInvitation.findOneAndUpdate(
        {
          _id: req.params.invitationId,
          orgId: req.user.orgId,
          status: { $in: ['pending', 'expired'] },
        },
        { $set: { status: 'revoked', revokedAt: new Date() } },
        { new: true, session }
      );
      if (!invitation) return;
      await recordAccessAudit({
        orgId: req.user.orgId,
        actorUserId: req.user.id,
        action: 'invitation.revoked',
        targetEmail: invitation.email,
        details: { invitationId: invitation._id },
        requestId: req.id,
        session,
      });
    });
    if (!invitation) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }
    return res.status(200).json({
      success: true,
      message: 'Invitation revoked',
      seats: await buildSeatSummary(req.user.orgId),
    });
  } catch (error) {
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  inviteManager, previewInvitation, acceptInvitation, resendInvitation, revokeInvitation,
};
