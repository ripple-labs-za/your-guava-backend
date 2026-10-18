const jwt = require('jsonwebtoken');
const { applyDuePlanChange, formatBillingDate, planChangeIsDue } = require('../services/billingPayments.service');
const User = require('../models/User.model');
const Organization = require('../models/Organization.model');
const { billingAccessForOrganization } = require('../services/usage.service');

const BILLING_EXEMPT_PREFIXES = ['/api/account', '/api/auth'];
const OBJECT_ID = '[a-f0-9]{24}';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GRACE_BLOCKED_READS = [/^\/api\/integrations\/[^/]+\/auth\/?$/i, /^\/api\/yoco\/auth\/?$/i];
const allowedDuringGrace = (req) => {
  const path = String(req.originalUrl || '').split('?')[0];
  if (READ_METHODS.has(req.method)) return !GRACE_BLOCKED_READS.some((pattern) => pattern.test(path));
  return req.method === 'POST' && path === '/api/team/switch-cafe';
};
// A lapsed organisation must still be able to shrink to a smaller plan, or checkout refuses the downgrade it needs (identity-7).
// Only routes that read, or reduce seats and locations, are exempt; nothing that adds data or spends credits.
const BILLING_EXEMPT_ROUTES = [
  ['GET', /^\/api\/team\/?$/],
  ['DELETE', new RegExp(`^/api/team/${OBJECT_ID}$`, 'i')],
  ['DELETE', new RegExp(`^/api/team/invitations/${OBJECT_ID}$`, 'i')],
  ['POST', new RegExp(`^/api/team/cafes/${OBJECT_ID}/archive$`, 'i')],
  ['POST', /^\/api\/team\/switch-cafe$/],
  ['GET', /^\/api\/cafe\/list$/],
];

const sessionExpired = (res) =>
  res.status(401).json({ success: false, message: 'Session expired. Please sign in again' });

const isBillingExempt = (req) => {
  const path = String(req.originalUrl || '').split('?')[0];
  if (BILLING_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  return BILLING_EXEMPT_ROUTES.some(([method, pattern]) => req.method === method && pattern.test(path));
};

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id)
      .select('tokenVersion role orgId cafeIds activeCafeId permissions')
      .lean();

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    const tokenVersion = Number(decoded.tokenVersion || 0);
    const currentTokenVersion = Number(user.tokenVersion || 0);
    if (tokenVersion !== currentTokenVersion) {
      return sessionExpired(res);
    }

    const liveOrgId = user.orgId ? String(user.orgId) : null;
    const tokenOrgId = decoded.orgId ? String(decoded.orgId) : null;
    const liveCafeIds = (user.cafeIds || []).map(String);
    const tokenCafeId = decoded.cafeId ? String(decoded.cafeId) : null;

    if (
      !liveOrgId ||
      tokenOrgId !== liveOrgId ||
      decoded.role !== user.role ||
      // WS-07-T04: a token must name a cafe the user can open; only a user with no cafes may carry none.
      (tokenCafeId ? !liveCafeIds.includes(tokenCafeId) : liveCafeIds.length > 0)
    ) {
      return sessionExpired(res);
    }

    // Identity-2: a tab states which cafe it is showing. A token for another cafe must not act for it, whatever produced the token.
    const tabCafeId = req.get('x-cafe-id');
    if (tabCafeId !== undefined && tabCafeId !== '' && String(tabCafeId).toLowerCase() !== (tokenCafeId || '').toLowerCase()) {
      return res.status(409).json({
        success: false,
        code: 'CAFE_CONTEXT_MISMATCH',
        cafeId: tokenCafeId,
        message: 'This tab is showing a different cafe. Reload the page to continue.',
      });
    }

    let organization = await Organization.findById(liveOrgId).lean();
    if (!organization) return sessionExpired(res);
    // D-019: start the paid scheduled term before checking billing access.
    if (planChangeIsDue(organization)) {
      organization = (await applyDuePlanChange(organization)) || organization;
    }

    let billing = billingAccessForOrganization(organization);
    if (!billing.allowed && ['trialing', 'active'].includes(organization.billingStatus)) {
      await Organization.updateOne(
        {
          _id: organization._id, billingStatus: organization.billingStatus,
          __v: organization.__v,
          currentPeriodEnd: organization.currentPeriodEnd ?? null,
          trialEndsAt: organization.trialEndsAt ?? null,
        },
        { $set: { billingStatus: 'past_due' } }
      );
      billing = { ...billing, storedStatus: 'past_due' };
    }

    req.user = {
      ...decoded,
      id: String(user._id),
      role: user.role,
      orgId: liveOrgId,
      cafeId: tokenCafeId,
      cafeIds: liveCafeIds,
      activeCafeId: user.activeCafeId ? String(user.activeCafeId) : null,
      permissions: {
        canSpendCredits:
          user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
      },
    };
    req.billing = billing;

    if (!billing.allowed && !isBillingExempt(req) && !(billing.readOnly && allowedDuringGrace(req))) {
      return res.status(402).json({
        success: false,
        code: 'BILLING_REQUIRED',
        message: billing.readOnly
          ? `Your plan has ended. Guava is read-only until ${formatBillingDate(billing.graceEndsAt)}: renew in Billing to make changes.`
          : 'An active trial or paid billing period is required',
        billing: {
          status: billing.status,
          reason: billing.reason,
          periodEnd: billing.periodEnd,
          readOnly: Boolean(billing.readOnly),
          graceEndsAt: billing.graceEndsAt || null,
        },
      });
    }

    next();
  } catch (error) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    return next(error);
  }
};

module.exports = authMiddleware;
