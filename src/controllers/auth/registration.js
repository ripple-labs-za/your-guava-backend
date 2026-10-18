const logger = require('../../utils/logger');
// Registration: the pending-registration upsert, verification and its resend cap.
// Moved from auth.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../../models/User.model');
const Cafe = require('../../models/Cafe.model');
const Organization = require('../../models/Organization.model');
const TeamInvitation = require('../../models/TeamInvitation.model');
const PendingRegistration = require('../../models/PendingRegistration.model');
const emailService = require('../../services/email.service');
const { isValidEmail } = require('../../utils/email');
const { passwordInputError, hashPassword, passwordTooLong } = require('../../utils/password');
const { runAfterResponse } = require('../../utils/afterResponse');
const authThrottle = require('../../services/authThrottle.service');
const { generateOpaqueToken, sha256Hex, normalizedOpaqueToken } = require('../../utils/authPrimitives');

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_VERIFICATION_RESENDS = 5;
const MAX_VERIFY_PASSWORD_ATTEMPTS = 5;
const INVALID_VERIFICATION_MESSAGE = 'This verification link is invalid or has expired';
// One answer for every address that is accepted, so the page cannot tell a pending signup from a new one (and, after
// BE-02-T02, from an existing account).
const REGISTER_ACCEPTED_MESSAGE =
  'Check your inbox for the next step. If this email can start a new account, the link to finish signing up is there. ' +
  'If it already has an account, we have sent sign-in help instead.';

// New, pending and existing addresses leave register through this one function, so their answers cannot drift apart.
const respondToRegistration = (res, emailResult, email) => {
  if (!emailService.deliveryAccepted(emailResult)) {
    logger.error('verification_email_failed', { reason: emailResult?.reason, errorMessage: emailResult?.error?.message });
    return res.status(emailResult?.skipped ? 503 : 502).json({
      success: false,
      verificationRequired: true,
      code: 'VERIFICATION_EMAIL_FAILED',
      message: 'Your registration is saved, but the verification email could not be sent. Try resending it.',
    });
  }
  // deliveryMode is the same for every address, so BE-02-T02's uniformity holds; the page uses it to say when nothing was sent.
  return res.status(202).json({
    success: true,
    verificationRequired: true,
    email,
    message: REGISTER_ACCEPTED_MESSAGE,
    deliveryMode: emailService.deliveryMode(),
  });
};

// Identity-1: a new submission replaces a pending one (password, names, token), so the old link dies. Two simultaneous
// submissions race on the unique email index; the loser retries once and then updates the winner's document.
const upsertPendingRegistration = async (fields) => {
  const write = () => PendingRegistration.findOneAndUpdate(
    { email: fields.email },
    {
      $set: {
        passwordHash: fields.passwordHash,
        name: fields.name,
        cafeName: fields.cafeName,
        orgName: fields.orgName,
        tokenHash: fields.tokenHash,
        expiresAt: fields.expiresAt,
        resendCount: 0,
        verifyAttempts: 0,
      },
      $setOnInsert: { email: fields.email },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
  try {
    return await write();
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.email) return write();
    throw error;
  }
};

const register = async (req, res, next) => {
  try {
    const { email, password, name, cafeName, orgName } = req.body;

    if (!email || !password || !name) {
      return res
        .status(400)
        .json({ success: false, message: 'Email, password, and name are required' });
    }

    const passwordError = passwordInputError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, message: passwordError });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedName = String(name).trim();
    const suppliedCafeName = cafeName == null ? '' : String(cafeName).trim();
    const suppliedOrgName = orgName == null ? '' : String(orgName).trim();
    const normalizedCafeName = suppliedCafeName || 'My Cafe';
    const normalizedOrgName =
      suppliedOrgName || `${normalizedName}'s Organization`.slice(0, 120);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }
    if (normalizedName.length < 2 || normalizedName.length > 120) {
      return res.status(400).json({ success: false, message: 'Name must be between 2 and 120 characters' });
    }
    if (normalizedCafeName.length < 2 || normalizedCafeName.length > 120) {
      return res.status(400).json({ success: false, message: 'Cafe name must be between 2 and 120 characters' });
    }
    if (normalizedOrgName.length < 2 || normalizedOrgName.length > 120) {
      return res.status(400).json({ success: false, message: 'Organization name must be between 2 and 120 characters' });
    }

    // Over the recipient quota, answer exactly as usual but send nothing and leave any pending signup untouched, so a flood of
    // registers can neither mail-bomb the address nor keep replacing its link.
    const quota = await authThrottle.consumeRecipientQuota('signup', normalizedEmail);
    if (!quota.allowed) {
      return respondToRegistration(res, { sent: true }, normalizedEmail);
    }

    const existingUser = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (existingUser) {
      // Identity-4: same status, body and work as a new address: one bcrypt hash, one email.
      await hashPassword(password);
      const notice = await emailService.sendAccountExistsEmail({ user: { email: normalizedEmail } });
      return respondToRegistration(res, notice, normalizedEmail);
    }

    // Identity-3: a pending team invitation in any org no longer blocks a public signup.
    const verificationToken = generateOpaqueToken();
    const registration = await upsertPendingRegistration({
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      name: normalizedName,
      cafeName: normalizedCafeName,
      orgName: normalizedOrgName,
      tokenHash: sha256Hex(verificationToken),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    });

    const emailResult = await emailService.sendVerificationEmail({
      registration,
      verificationToken,
    });
    return respondToRegistration(res, emailResult, normalizedEmail);
  } catch (error) {
    next(error);
  }
};

// Runs after the response (identity-4): rotating and emailing must not decide how long the answer takes.
const rotateVerification = async (normalizedEmail) => {
  // Over quota nothing rotates, so the last link sent keeps working.
  if (!(await authThrottle.consumeRecipientQuota('signup', normalizedEmail)).allowed) return;
  const verificationToken = generateOpaqueToken();
  const tokenHash = sha256Hex(verificationToken);
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  const previousRegistration = await PendingRegistration.findOneAndUpdate(
    {
      email: normalizedEmail,
      expiresAt: { $gt: new Date() },
      // $not also matches records written before this field existed.
      resendCount: { $not: { $gte: MAX_VERIFICATION_RESENDS } },
    },
    { $set: { tokenHash, expiresAt }, $inc: { resendCount: 1 } },
    { new: false, runValidators: true }
  ).select('+tokenHash');
  if (!previousRegistration) return;
  const registration = {
    ...previousRegistration.toObject(),
    tokenHash: undefined,
    expiresAt,
  };
  const result = await emailService.sendVerificationEmail({ registration, verificationToken });
  if (!emailService.deliveryAccepted(result)) {
    await PendingRegistration.updateOne(
      { _id: previousRegistration._id, tokenHash },
      {
        $set: {
          tokenHash: previousRegistration.tokenHash,
          expiresAt: previousRegistration.expiresAt,
        },
      }
    );
    logger.error('verification_resend_failed', { reason: result?.reason, errorMessage: result?.error?.message });
  }
};

const resendVerification = async (req, res, next) => {
  try {
    const normalizedEmail =
      typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    const genericResponse = {
      success: true,
      message: 'If a pending registration exists, a new verification email has been sent.',
    };
    if (isValidEmail(normalizedEmail)) {
      runAfterResponse('verification resend', () => rotateVerification(normalizedEmail));
    }
    return res.status(200).json(genericResponse);
  } catch (error) {
    return next(error);
  }
};

const verifyEmail = async (req, res, next) => {
  let session;
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedOpaqueToken(req.body?.token);
    if (!token) {
      return res.status(404).json({ success: false, message: INVALID_VERIFICATION_MESSAGE });
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_REQUIRED',
        message: 'Enter the password you chose when you signed up.',
      });
    }

    const tokenHash = sha256Hex(token);
    const candidate = await PendingRegistration.findOne({ tokenHash, expiresAt: { $gt: new Date() } })
      .select('+passwordHash');
    if (!candidate) {
      return res.status(404).json({ success: false, message: INVALID_VERIFICATION_MESSAGE });
    }

    // Identity-1: never complete a sign-up with credentials the person holding the link did not supply.
    const matches = !passwordTooLong(password) && await bcrypt.compare(password, candidate.passwordHash);
    if (!matches) {
      const counted = await PendingRegistration.findOneAndUpdate(
        { _id: candidate._id, tokenHash },
        { $inc: { verifyAttempts: 1 } },
        { new: true }
      ).lean();
      const attempts = counted ? counted.verifyAttempts : MAX_VERIFY_PASSWORD_ATTEMPTS;
      if (attempts >= MAX_VERIFY_PASSWORD_ATTEMPTS) {
        await PendingRegistration.deleteOne({ _id: candidate._id, tokenHash });
        return res.status(404).json({ success: false, message: INVALID_VERIFICATION_MESSAGE });
      }
      return res.status(401).json({
        success: false,
        code: 'VERIFICATION_PASSWORD_MISMATCH',
        attemptsRemaining: MAX_VERIFY_PASSWORD_ATTEMPTS - attempts,
        message: 'That is not the password used for this sign-up. If you did not sign up, you can ignore the email.',
      });
    }

    let user;
    let org;
    let cafe;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Consume exactly the record whose password was checked: a register that replaced it in between changed the
      // tokenHash, so this finds nothing and the newer submission wins.
      const registration = await PendingRegistration.findOneAndDelete({
        _id: candidate._id,
        tokenHash,
        expiresAt: { $gt: new Date() },
      })
        .select('+passwordHash')
        .session(session);
      if (!registration) {
        const error = new Error(INVALID_VERIFICATION_MESSAGE);
        error.statusCode = 404;
        throw error;
      }
      const existingUser = await User.findOne({ email: registration.email }).session(session);
      if (existingUser) {
        const error = new Error('Email already registered');
        error.statusCode = 409;
        throw error;
      }

      // The hash taken at registration is the password; nothing is hashed again here (identity-13).
      user = new User({
        email: registration.email,
        password: registration.passwordHash,
        name: registration.name,
        role: 'owner',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      });
      user.$locals.passwordIsHash = true;
      await user.save({ session });
      [org] = await Organization.create([{
        name: registration.orgName,
        ownerId: user._id,
        billingEmail: registration.email,
      }], { session });
      [cafe] = await Cafe.create([{ name: registration.cafeName, orgId: org._id }], { session });
      await User.updateOne(
        { _id: user._id },
        { $set: { orgId: org._id, cafeIds: [cafe._id], activeCafeId: cafe._id } },
        { session }
      );
      user.orgId = org._id;
      user.cafeIds = [cafe._id];
      user.activeCafeId = cafe._id;

      // Identity-3: the self-registration wins. Invitations to this address stop holding a seat and can no longer be accepted.
      await TeamInvitation.updateMany(
        { email: registration.email, status: 'pending' },
        { $set: { status: 'expired', expiresAt: new Date() } },
        { session }
      );
    });

    emailService.sendWelcomeEmail({ user, org, cafe }).catch((error) => {
      logger.warn('welcome_email_failed', logger.errorFields(error));
    });
    return res.status(201).json({
      success: true,
      message: 'Email verified. You can now sign in.',
      email: user.email,
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  register, resendVerification, verifyEmail,
};
