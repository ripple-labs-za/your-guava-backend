// Members: seat counting, cafe access validation, listing, removing and updating members.
// Moved from team.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const User = require('../../models/User.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const TeamInvitation = require('../../models/TeamInvitation.model');
const AuthSession = require('../../models/AuthSession.model');
const InsightChat = require('../../models/InsightChat.model');
const { getPlan } = require('../../services/billingPlans.service');
const { recordAccessAudit } = require('./audit');

const normalizeCafeIds = (cafeIds) =>
  [
    ...new Set(
      (Array.isArray(cafeIds) ? cafeIds : [])
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];

const memberPermissions = (user) => ({
  canSpendCredits: user?.role === 'owner' || Boolean(user?.permissions?.canSpendCredits),
});

const expirePendingInvitations = async (orgId, session = null) => {
  const query = {
    status: 'pending',
    expiresAt: { $lte: new Date() },
    ...(orgId ? { orgId } : {}),
  };
  const options = session ? { session } : undefined;
  await TeamInvitation.updateMany(query, { $set: { status: 'expired' } }, options);
};

const buildSeatSummary = async (orgId) => {
  await expirePendingInvitations(orgId);
  const org = await Organization.findById(orgId).lean();
  const [active, pending] = await Promise.all([
    User.countDocuments({ orgId }),
    TeamInvitation.countDocuments({
      orgId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }),
  ]);
  const used = active + pending;
  const plan = getPlan(org?.plan);
  return {
    plan: plan.id,
    used,
    active,
    pending,
    included: plan.includedSeats,
    remaining: Math.max(0, plan.includedSeats - used),
  };
};

const validateCafeAccess = async (orgId, cafeIds = [], session = null) => {
  const requestedIds = [...new Set((Array.isArray(cafeIds) ? cafeIds : []).map(String))];
  const query = Cafe.find({ orgId, _id: { $in: requestedIds }, archivedAt: null }).select('_id');
  if (session) query.session(session);
  const orgCafes = await query;
  const orgCafeIds = orgCafes.map((cafe) => cafe._id.toString());
  return requestedIds.filter((id) => orgCafeIds.includes(id));
};

// GET /api/team - List all team members in the organisation.
const listTeam = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    await expirePendingInvitations(user.orgId);
    const members = await User.find({ orgId: user.orgId })
      .select('name email role cafeIds activeCafeId permissions createdAt')
      .populate('cafeIds', 'name')
      .lean();
    const invitations = await TeamInvitation.find({
      orgId: user.orgId,
      status: { $in: ['pending', 'expired'] },
    })
      .select('name email cafeIds permissions status expiresAt createdAt')
      .populate('cafeIds', 'name')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    const seats = await buildSeatSummary(user.orgId);

    return res.status(200).json({
      success: true,
      members: members.map((member) => ({
        ...member,
        permissions: memberPermissions(member),
      })),
      invitations,
      seats,
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/team/:userId - Owner removes a manager from the organisation.
const removeMember = async (req, res, next) => {
  let session;
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    let target;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      target = await User.findOne({
        _id: req.params.userId,
        orgId: req.user.orgId,
      }).session(session);
      if (!target) return;
      if (target.role === 'owner') {
        const error = new Error('Cannot remove the owner');
        error.statusCode = 403;
        throw error;
      }
      await User.deleteOne({ _id: target._id, orgId: req.user.orgId }, { session });
      await AuthSession.deleteMany({ userId: target._id }, { session });
      // Legacy chats may lack orgId. Cafe ownership supplies the organisation
      // boundary in that case, including archived locations.
      const cafes = await Cafe.find({ orgId: req.user.orgId }).select('_id').session(session).lean();
      await InsightChat.deleteMany({
        userId: target._id,
        $or: [
          { orgId: req.user.orgId },
          { orgId: null, cafeId: { $in: cafes.map((cafe) => cafe._id) } },
        ],
      }, { session });
      await recordAccessAudit({
        orgId: req.user.orgId,
        actorUserId: req.user.id,
        targetUserId: target._id,
        action: 'member.removed',
        targetEmail: target.email,
        details: {
          role: target.role,
          cafeIds: target.cafeIds,
          permissions: memberPermissions(target),
        },
        requestId: req.id,
        session,
      });
    });
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const seats = await buildSeatSummary(req.user.orgId);

    return res.status(200).json({ success: true, message: 'Member removed', seats });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};


// PATCH /api/team/:userId - Owner updates member profile and cafe access.
const updateMember = async (req, res, next) => {
  let session;
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const body = req.body || {};
    const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
    const hasCafeIds = Object.prototype.hasOwnProperty.call(body, 'cafeIds');
    const hasSpendPermission = Object.prototype.hasOwnProperty.call(body, 'canSpendCredits');
    if (!hasName && !hasCafeIds && !hasSpendPermission) {
      return res.status(400).json({ success: false, message: 'No supported member fields were provided' });
    }
    const cleanName = typeof body.name === 'string' ? body.name.trim() : null;
    if (hasName && (!cleanName || cleanName.length < 2 || cleanName.length > 120)) {
      return res.status(400).json({ success: false, message: 'Name must be between 2 and 120 characters' });
    }
    const requestedCafeIds = hasCafeIds ? normalizeCafeIds(body.cafeIds) : null;
    const submittedCafeIds = hasCafeIds && Array.isArray(body.cafeIds)
      ? body.cafeIds.map(String)
      : [];
    if (
      hasCafeIds &&
      (requestedCafeIds.length === 0 ||
        requestedCafeIds.length !== new Set(submittedCafeIds).size)
    ) {
      return res.status(400).json({ success: false, message: 'Select valid cafe access' });
    }
    if (hasSpendPermission && typeof body.canSpendCredits !== 'boolean') {
      return res.status(400).json({ success: false, message: 'canSpendCredits must be a boolean' });
    }

    let target;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      target = await User.findOne({
        _id: req.params.userId,
        orgId: req.user.orgId,
      }).session(session);
      if (!target) return;
      if (target.role === 'owner') {
        const error = new Error('Owner details must be changed from My Account');
        error.statusCode = 403;
        throw error;
      }
      const before = {
        name: target.name,
        cafeIds: target.cafeIds.map(String),
        permissions: memberPermissions(target),
      };
      if (hasName) target.name = cleanName;
      if (hasCafeIds) {
        const validCafeIds = await validateCafeAccess(req.user.orgId, requestedCafeIds, session);
        if (validCafeIds.length !== requestedCafeIds.length) {
          const error = new Error('Select valid cafe access');
          error.statusCode = 400;
          throw error;
        }
        target.cafeIds = validCafeIds;
        if (!validCafeIds.includes(target.activeCafeId?.toString())) {
          target.activeCafeId = validCafeIds[0];
        }
      }
      if (hasSpendPermission) {
        target.permissions = target.permissions || {};
        target.permissions.canSpendCredits = body.canSpendCredits;
      }
      await target.save({ session });
      await recordAccessAudit({
        orgId: req.user.orgId,
        actorUserId: req.user.id,
        targetUserId: target._id,
        action: 'member.updated',
        targetEmail: target.email,
        details: {
          before,
          after: {
            name: target.name,
            cafeIds: target.cafeIds.map(String),
            permissions: memberPermissions(target),
          },
        },
        requestId: req.id,
        session,
      });
    });
    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const member = await User.findById(target._id)
      .select('name email role cafeIds activeCafeId permissions createdAt')
      .populate('cafeIds', 'name')
      .lean();

    return res.status(200).json({
      success: true,
      member: { ...member, permissions: memberPermissions(member) },
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  normalizeCafeIds, memberPermissions, expirePendingInvitations, buildSeatSummary, validateCafeAccess, listTeam,
  removeMember, updateMember,
};
