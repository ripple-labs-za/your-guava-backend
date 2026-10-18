// Cafes: switching the active cafe, adding a location, archiving and restoring one (BE-02-T08).
// Moved from team.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const User = require('../../models/User.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const TeamInvitation = require('../../models/TeamInvitation.model');
const { getPlan } = require('../../services/billingPlans.service');
const { getPlanCapacity } = require('../../services/planCapacity.service');
const { recordAccessAudit } = require('./audit');
const { generateAccessToken } = require('../../utils/authPrimitives');
const { clearApiCache } = require('../../middleware/cache.middleware');

// POST /api/team/switch-cafe - Switch active cafe.
const switchCafe = async (req, res, next) => {
  try {
    const { cafeId } = req.body;
    if (!mongoose.isValidObjectId(cafeId)) {
      return res.status(400).json({ success: false, message: 'Select a valid cafe' });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Session expired. Please sign in again' });
    }

    if (!user.cafeIds.map((id) => id.toString()).includes(String(cafeId))) {
      return res.status(403).json({ success: false, message: 'You do not have access to this cafe' });
    }

    user.activeCafeId = cafeId;
    await user.save();

    const accessToken = generateAccessToken(user._id, cafeId, user.role, user.orgId, user.tokenVersion);

    return res.status(200).json({ success: true, accessToken, activeCafeId: cafeId });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/add-cafe - Owner adds a new cafe location to the organisation.
const addCafe = async (req, res, next) => {
  let session;
  try {
    const { name, address, city, lat, lng } = req.body;
    const owner = await User.findById(req.user.id);

    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanAddress = address == null ? '' : typeof address === 'string' ? address.trim() : null;
    const cleanCity = city == null ? '' : typeof city === 'string' ? city.trim() : null;
    if (cleanName.length < 2 || cleanName.length > 120) {
      return res.status(400).json({ success: false, message: 'Cafe name must be between 2 and 120 characters' });
    }
    if (cleanAddress === null || cleanAddress.length > 240) {
      return res.status(400).json({ success: false, message: 'Address must be text up to 240 characters' });
    }
    if (cleanCity === null || cleanCity.length > 120) {
      return res.status(400).json({ success: false, message: 'City must be text up to 120 characters' });
    }

    const parsedLat = lat == null || lat === '' ? undefined : Number(lat);
    const parsedLng = lng == null || lng === '' ? undefined : Number(lng);
    if ((parsedLat === undefined) !== (parsedLng === undefined)) {
      return res.status(400).json({ success: false, message: 'lat and lng must be provided together' });
    }
    if (
      (parsedLat !== undefined && (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90)) ||
      (parsedLng !== undefined && (!Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180))
    ) {
      return res.status(400).json({ success: false, message: 'Invalid latitude or longitude' });
    }

    let cafe;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
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

      const plan = getPlan(org.plan);
      const locationCount = await Cafe.countDocuments({ orgId: owner.orgId, archivedAt: null }).session(session);
      if (locationCount >= plan.includedLocations) {
        const error = new Error(
          `Location limit reached on the ${plan.name} plan. Upgrade your plan to add more cafes.`
        );
        error.statusCode = 402;
        error.locations = {
          used: locationCount,
          included: plan.includedLocations,
          remaining: 0,
        };
        throw error;
      }

      [cafe] = await Cafe.create([{
        name: cleanName,
        orgId: owner.orgId,
        location: {
          ...(cleanAddress ? { address: cleanAddress } : {}),
          ...(cleanCity ? { city: cleanCity } : {}),
          ...(parsedLat !== undefined ? { lat: parsedLat, lng: parsedLng } : {}),
        },
      }], { session });

      await User.updateOne(
        { _id: owner._id, orgId: owner.orgId },
        { $addToSet: { cafeIds: cafe._id } },
        { session }
      );
      await recordAccessAudit({
        orgId: owner.orgId,
        actorUserId: owner._id,
        action: 'location.created',
        details: { cafeId: cafe._id, name: cafe.name },
        requestId: req.id,
        session,
      });
    });

    clearApiCache({ orgId: owner.orgId });
    return res.status(201).json({ success: true, cafe });
  } catch (error) {
    if (error?.statusCode === 402 && error?.locations) {
      return res.status(402).json({
        success: false,
        message: error.message,
        locations: error.locations,
      });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const CAFE_ID_RE = /^[a-f0-9]{24}$/i;

const httpError = (statusCode, message, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });

// POST /api/team/cafes/:cafeId/archive - Owner archives a location. Its data is kept; it leaves quotas and access (identity-8).
const archiveCafe = async (req, res, next) => {
  let session;
  try {
    const { cafeId } = req.params;
    if (!CAFE_ID_RE.test(String(cafeId))) return res.status(404).json({ success: false, message: 'Location not found' });
    let archived;
    let plan;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Touching the organization serialises location changes for this tenant, as addCafe does.
      const org = await Organization.findOneAndUpdate(
        { _id: req.user.orgId },
        { $set: { updatedAt: new Date() }, $inc: { __v: 1 } },
        { new: true, session }
      );
      if (!org) throw httpError(404, 'Organization not found');
      plan = org.plan;
      const cafe = await Cafe.findOne({ _id: cafeId, orgId: req.user.orgId, archivedAt: null }).session(session);
      if (!cafe) throw httpError(404, 'Location not found');
      const activeCount = await Cafe.countDocuments({ orgId: req.user.orgId, archivedAt: null }).session(session);
      if (activeCount <= 1) {
        throw httpError(409, 'An organisation needs at least one active location.', { code: 'LAST_LOCATION' });
      }
      const stranded = await User.find({ orgId: req.user.orgId, role: 'manager', cafeIds: cafe._id, 'cafeIds.1': { $exists: false } })
        .select('name')
        .session(session);
      if (stranded.length > 0) {
        throw httpError(
          409,
          `Give these managers another location or remove them first: ${stranded.map((member) => member.name).join(', ')}.`,
          { code: 'LOCATION_HAS_MEMBERS', members: stranded.map((member) => ({ id: member._id, name: member.name })) }
        );
      }

      cafe.archivedAt = new Date();
      cafe.archivedByUserId = req.user.id;
      cafe.yocoConnected = false;
      cafe.yocoTokens = undefined;
      cafe.yocoBusinessId = undefined;
      cafe.yocoWebhookSubscriptionId = undefined;
      await cafe.save({ session });
      await User.updateMany({ orgId: req.user.orgId, cafeIds: cafe._id }, { $pull: { cafeIds: cafe._id } }, { session });
      // Anyone whose default was this cafe moves to their first remaining one; their tabs reload onto it (BE-02-T04).
      const moved = await User.find({ orgId: req.user.orgId, activeCafeId: cafe._id }).select('cafeIds').session(session);
      for (const member of moved) {
        await User.updateOne({ _id: member._id }, { $set: { activeCafeId: member.cafeIds[0] || null } }, { session });
      }
      await TeamInvitation.updateMany(
        { orgId: req.user.orgId, status: 'pending', cafeIds: cafe._id },
        { $pull: { cafeIds: cafe._id } },
        { session }
      );
      await TeamInvitation.updateMany(
        { orgId: req.user.orgId, status: 'pending', cafeIds: { $size: 0 } },
        { $set: { status: 'revoked', revokedAt: new Date() } },
        { session }
      );
      await recordAccessAudit({
        orgId: req.user.orgId,
        actorUserId: req.user.id,
        action: 'location.archived',
        details: { cafeId: cafe._id, name: cafe.name },
        requestId: req.id,
        session,
      });
      archived = cafe;
    });

    clearApiCache({ orgId: req.user.orgId });
    const capacity = await getPlanCapacity(req.user.orgId, plan);
    return res.status(200).json({
      success: true,
      cafe: { _id: archived._id, name: archived.name, archivedAt: archived.archivedAt },
      locations: capacity.locations,
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.members ? { members: error.members } : {}),
      });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// POST /api/team/cafes/:cafeId/restore - Owner brings an archived location back if the plan has room.
const restoreCafe = async (req, res, next) => {
  let session;
  try {
    const { cafeId } = req.params;
    if (!CAFE_ID_RE.test(String(cafeId))) return res.status(404).json({ success: false, message: 'Location not found' });
    let restored;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const org = await Organization.findOneAndUpdate(
        { _id: req.user.orgId },
        { $set: { updatedAt: new Date() }, $inc: { __v: 1 } },
        { new: true, session }
      );
      if (!org) throw httpError(404, 'Organization not found');
      const cafe = await Cafe.findOne({ _id: cafeId, orgId: req.user.orgId, archivedAt: { $ne: null } }).session(session);
      if (!cafe) throw httpError(404, 'Location not found');
      const plan = getPlan(org.plan);
      const activeCount = await Cafe.countDocuments({ orgId: req.user.orgId, archivedAt: null }).session(session);
      if (activeCount >= plan.includedLocations) {
        throw httpError(402, `Location limit reached on the ${plan.name} plan. Archive another location or upgrade first.`, {
          locations: { used: activeCount, included: plan.includedLocations, remaining: 0 },
        });
      }
      cafe.archivedAt = null;
      cafe.archivedByUserId = undefined;
      await cafe.save({ session });
      await User.updateOne({ _id: org.ownerId, orgId: org._id }, { $addToSet: { cafeIds: cafe._id } }, { session });
      await recordAccessAudit({
        orgId: req.user.orgId,
        actorUserId: req.user.id,
        action: 'location.restored',
        details: { cafeId: cafe._id, name: cafe.name },
        requestId: req.id,
        session,
      });
      restored = cafe;
    });
    clearApiCache({ orgId: req.user.orgId });
    return res.status(200).json({ success: true, cafe: { _id: restored._id, name: restored.name, archivedAt: null } });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.locations ? { locations: error.locations } : {}),
      });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  switchCafe, addCafe, archiveCafe, restoreCafe,
};
