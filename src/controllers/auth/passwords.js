const logger = require('../../utils/logger');
// Passwords: forgot (deferred delivery), reset and change.
// Moved from auth.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const User = require('../../models/User.model');
const PasswordResetToken = require('../../models/PasswordResetToken.model');
const AuthSession = require('../../models/AuthSession.model');
const AccessAuditEvent = require('../../models/AccessAuditEvent.model');
const emailService = require('../../services/email.service');
const { isValidEmail } = require('../../utils/email');
const { passwordInputError, passwordTooLong } = require('../../utils/password');
const { runAfterResponse } = require('../../utils/afterResponse');
const authThrottle = require('../../services/authThrottle.service');
const { generateOpaqueToken, sha256Hex, normalizedOpaqueToken, clearRefreshCookie } = require('../../utils/authPrimitives');

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

const FORGOT_PASSWORD_RESPONSE = {
  success: true,
  message: 'If an account exists for that email, a password reset link has been sent.',
};

// Runs after the response, so its duration cannot tell anyone whether the account exists (identity-4).
const deliverPasswordReset = async (normalizedEmail) => {
  // The recipient quota is consumed before the lookup, so an unknown address costs exactly what a real one does.
  if (!(await authThrottle.consumeRecipientQuota('password_reset', normalizedEmail)).allowed) return;
  const user = await User.findOne({ email: normalizedEmail }).select('_id email name').lean();
  if (!user) return;
  const resetToken = generateOpaqueToken();
  const record = await PasswordResetToken.create({
    userId: user._id,
    tokenHash: sha256Hex(resetToken),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
  });
  // Create first, then revoke only the older pending links (lower _id): requests a moment apart run these steps side
  // by side after their responses, and revoke-then-create let each revoke the others before they existed, leaving
  // several live links (UAT-01-S05). Whatever the interleaving, the newest link is the one that stays.
  await PasswordResetToken.updateMany(
    { userId: user._id, status: 'pending', _id: { $lt: record._id } },
    { $set: { status: 'revoked', revokedAt: new Date() } }
  );
  const result = await emailService.sendPasswordResetEmail({ user, resetToken, expiresAt: record.expiresAt });
  if (!emailService.deliveryAccepted(result)) {
    await PasswordResetToken.updateOne(
      { _id: record._id, status: 'pending' },
      { $set: { status: 'revoked', revokedAt: new Date() } }
    );
    logger.error('password_reset_email_failed', { reason: result?.reason, errorMessage: result?.error?.message });
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const normalizedEmail = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    if (isValidEmail(normalizedEmail)) {
      runAfterResponse('password reset delivery', () => deliverPasswordReset(normalizedEmail));
    }
    return res.status(200).json(FORGOT_PASSWORD_RESPONSE);
  } catch (error) {
    return next(error);
  }
};

const resetPassword = async (req, res, next) => {
  let session;
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedOpaqueToken(req.body?.token);
    const newPassword = req.body?.password;
    if (!token) {
      return res.status(404).json({ success: false, message: 'This reset link is invalid or has expired' });
    }
    const newPasswordError = passwordInputError(newPassword);
    if (newPasswordError) {
      return res.status(400).json({ success: false, message: newPasswordError });
    }

    let holder;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const reset = await PasswordResetToken.findOneAndUpdate(
        {
          tokenHash: sha256Hex(token),
          status: 'pending',
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'accepting' } },
        { new: true, session }
      );
      if (!reset) {
        const error = new Error('This reset link is invalid or has expired');
        error.statusCode = 404;
        throw error;
      }
      const user = await User.findById(reset.userId).select('+password').session(session);
      if (user) holder = { email: user.email, name: user.name };
      if (!user) {
        const error = new Error('This reset link is invalid or has expired');
        error.statusCode = 404;
        throw error;
      }
      if (await user.comparePassword(newPassword)) {
        const error = new Error('New password must be different from the current password');
        error.statusCode = 400;
        throw error;
      }
      user.password = newPassword;
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      await user.save({ session });
      await AuthSession.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'password_reset' } },
        { session }
      );
      reset.status = 'used';
      reset.usedAt = new Date();
      await reset.save({ session });
      if (user.orgId) {
        await AccessAuditEvent.create([{
          orgId: user.orgId,
          actorUserId: user._id,
          targetUserId: user._id,
          action: 'password.reset',
          targetEmail: user.email,
          requestId: req.id,
        }], { session });
      }
    });

    emailService.sendSecurityNoticeEmail({ kind: 'password_reset', user: holder })
      .catch((error) => logger.warn('password_reset_notice_failed', logger.errorFields(error)));

    clearRefreshCookie(res);
    return res.status(200).json({
      success: true,
      message: 'Password reset. You can now sign in.',
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const changePassword = async (req, res, next) => {
  let session;
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }
    const newPasswordError = passwordInputError(newPassword, { label: 'New password' });
    if (newPasswordError) {
      return res.status(400).json({ success: false, message: newPasswordError });
    }
    // bcrypt reads 72 bytes, so an over-long "current password" could match on its prefix. It can never be the real one.
    if (passwordTooLong(currentPassword)) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    let holder;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const user = await User.findById(req.user.id).select('+password').session(session);
      if (user) holder = { email: user.email, name: user.name };
      if (!user) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }

      const currentMatches = await user.comparePassword(currentPassword);
      if (!currentMatches) {
        const error = new Error('Current password is incorrect');
        error.statusCode = 401;
        throw error;
      }

      const reusedPassword = await user.comparePassword(newPassword);
      if (reusedPassword) {
        const error = new Error('New password must be different from the current password');
        error.statusCode = 400;
        throw error;
      }

      user.password = newPassword;
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      await user.save({ session });
      await AuthSession.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'password_change' } },
        { session }
      );
      await AccessAuditEvent.create([{
        orgId: user.orgId,
        actorUserId: user._id,
        targetUserId: user._id,
        action: 'password.changed',
        targetEmail: user.email,
        requestId: req.id,
      }], { session });
    });

    // identity-16: the account holder hears about it; a failed notice never fails the change.
    emailService.sendSecurityNoticeEmail({ kind: 'password_changed', user: holder })
      .catch((error) => logger.warn('password_change_notice_failed', logger.errorFields(error)));

    clearRefreshCookie(res);

    return res.status(200).json({
      success: true,
      message: 'Password changed. Please sign in again.',
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
  forgotPassword, resetPassword, changePassword,
};
