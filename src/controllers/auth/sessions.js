// Sessions: login, refresh with the reuse grace, logout, me.
// Moved from auth.controller.js by BE-11-T04; behaviour unchanged.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../../models/User.model');
const AuthSession = require('../../models/AuthSession.model');
const AccessAuditEvent = require('../../models/AccessAuditEvent.model');
const { isValidEmail } = require('../../utils/email');
const { passwordTooLong, dummyPasswordHash } = require('../../utils/password');
const authThrottle = require('../../services/authThrottle.service');
const { resolveSessionCafeId } = require('../../utils/sessionCafe');
const { issueSession, generateRefreshToken, refreshTokenExpiry } = require('./tokens');
const { sha256Hex, generateAccessToken, setRefreshCookie, clearRefreshCookie } = require('../../utils/authPrimitives');
const { activeCafeId } = require('../../utils/tenancy');

// A lost response on a slow connection is retried well inside this (identity-15).
const REFRESH_REUSE_GRACE_MS = 2 * 60 * 1000;

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    if (!isValidEmail(normalizedEmail) || passwordTooLong(password)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Per-account throttle (platform-3, security-9): after five failures the address is blocked whatever the IP, and a
    // refused attempt costs no lookup and no bcrypt.
    const gate = await authThrottle.loginGate(normalizedEmail);
    if (!gate.allowed) {
      const minutes = Math.ceil(gate.retryAfterSeconds / 60);
      res.set('Retry-After', String(gate.retryAfterSeconds));
      return res.status(429).json({
        success: false,
        code: 'LOGIN_THROTTLED',
        retryAfterSeconds: gate.retryAfterSeconds,
        message: `Too many failed sign-in attempts for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    if (!user) {
      // Identity-4: an unknown address costs the same bcrypt compare as a wrong password for a real one.
      await bcrypt.compare(password, await dummyPasswordHash());
      await authThrottle.recordLoginFailure(normalizedEmail);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await authThrottle.recordLoginFailure(normalizedEmail);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    await authThrottle.clearLoginFailures(normalizedEmail);

    if (user.emailVerified === false) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Verify your email address before signing in',
      });
    }

    const { accessToken, refreshToken, cafeId } = await issueSession(user);

    setRefreshCookie(res, refreshToken);

    return res.status(200).json({
      success: true,
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
        cafeIds: user.cafeIds,
        activeCafeId: cafeId,
        permissions: {
          canSpendCredits: user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

const refresh = async (req, res, next) => {
  try {
    const requestedCafeId = req.body?.cafeId;
    const token = req.cookies?.refreshToken;

    if (!token) {
      return res.status(401).json({ success: false, message: 'No refresh token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const tokenHash = sha256Hex(token);
    let user;
    let newRefreshToken;

    if (decoded.sid) {
      newRefreshToken = generateRefreshToken(decoded.id, decoded.sid);
      const replacementClaims = jwt.decode(newRefreshToken);
      const now = new Date();
      const rotated = await AuthSession.findOneAndUpdate(
        {
          userId: decoded.id,
          familyId: decoded.sid,
          currentTokenHash: tokenHash,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            currentTokenHash: sha256Hex(newRefreshToken),
            previousTokenHash: tokenHash,
            previousValidUntil: new Date(now.getTime() + REFRESH_REUSE_GRACE_MS),
            graceTokenId: replacementClaims.jti,
            graceTokenIssuedAt: replacementClaims.iat,
            expiresAt: refreshTokenExpiry(newRefreshToken),
            lastUsedAt: now,
          },
        },
        { new: true }
      );
      if (!rotated) {
        // Tabs share the HttpOnly cookie but not the portal's in-memory refresh
        // lock. A near-simultaneous request may therefore carry the token that
        // was just rotated. Briefly reissue the same replacement so response
        // ordering cannot leave the browser holding an already-invalid token.
        const graceSession = await AuthSession.findOne({
          userId: decoded.id,
          familyId: decoded.sid,
          previousTokenHash: tokenHash,
          previousValidUntil: { $gt: now },
          revokedAt: null,
          expiresAt: { $gt: now },
        }).select('+graceTokenId +graceTokenIssuedAt');
        if (
          graceSession?.graceTokenId &&
          Number.isFinite(graceSession.graceTokenIssuedAt)
        ) {
          newRefreshToken = generateRefreshToken(decoded.id, decoded.sid, {
            tokenId: graceSession.graceTokenId,
            issuedAt: graceSession.graceTokenIssuedAt,
            expiresAt: Math.floor(graceSession.expiresAt.getTime() / 1000),
          });
          user = await User.findById(decoded.id);
          if (!user) {
            await AuthSession.updateOne(
              { _id: graceSession._id, revokedAt: null },
              { $set: { revokedAt: new Date(), revokeReason: 'user_missing' } }
            );
            return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
          }
        } else {
          // Outside the narrow concurrency grace, a valid signed token that is
          // no longer current is a replay signal. Revoke the whole family,
          // including its replacement.
          const revoked = await AuthSession.updateOne(
            { userId: decoded.id, familyId: decoded.sid, revokedAt: null },
            { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } }
          );
          if (revoked.modifiedCount > 0) {
            // identity-16: the revocation is audited once (not emailed: after the grace window an innocent retry looks the same).
            const holder = await User.findById(decoded.id).select('orgId email').lean();
            if (holder?.orgId) {
              await AccessAuditEvent.create({
                orgId: holder.orgId,
                actorUserId: holder._id,
                targetUserId: holder._id,
                action: 'session.reuse_detected',
                targetEmail: holder.email,
                details: { familyId: decoded.sid },
                requestId: req.id,
              });
            }
          }
          return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
        }
      }
      if (!user) user = await User.findById(decoded.id);
      if (!user && rotated) {
        await AuthSession.updateOne(
          { _id: rotated._id },
          { $set: { revokedAt: new Date(), revokeReason: 'user_missing' } }
        );
        return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
      }
    } else {
      // Tokens without a family predate AuthSession and expired in August 2026.
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    // Identity-2: the tab says which cafe it is showing; the user record only supplies the default for a tab that has none.
    const cafeId = resolveSessionCafeId(user, requestedCafeId);
    const accessToken = generateAccessToken(user._id, cafeId, user.role, user.orgId, user.tokenVersion);
    setRefreshCookie(res, newRefreshToken);

    return res.status(200).json({ success: true, accessToken, cafeId });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken;

    if (token) {
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      } catch (_) {
        decoded = null;
      }
      if (decoded?.sid) {
        await AuthSession.updateOne(
          { userId: decoded.id, familyId: decoded.sid, revokedAt: null },
          { $set: { revokedAt: new Date(), revokeReason: 'logout' } }
        );
      }
    }

    clearRefreshCookie(res);

    return res.status(200).json({ success: true, message: 'Logged out' });
  } catch (error) {
    next(error);
  }
};

const me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      cafeIds: user.cafeIds,
      // The calling token's cafe (identity-2), not the database default.
      activeCafeId: activeCafeId(req) || null,
      emailVerified: user.emailVerified !== false,
      permissions: {
        canSpendCredits: user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login, refresh, logout, me,
};
