const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const PaymentSession = require('../models/PaymentSession.model');
const TeamInvitation = require('../models/TeamInvitation.model');
const AccessAuditEvent = require('../models/AccessAuditEvent.model');
const {
  getPlan,
  getPlans,
  normalisePlanId,
  nextMonthlyAnniversary,
} = require('../services/billingPlans.service');
const {
  billingPeriodForPayment,
  createHostedPaymentSession,
  fulfilMockCreditPurchase,
  getCreditPack,
  invalidateFutureForecastsForOrg,
  reconcileOneGatePayment,
  normalizePaymentReference,
} = require('../services/billingPayments.service');
const {
  billingAccessForOrganization,
  billingRequiredError,
  bonusUsedForCredits,
  creditSnapshot,
  refreshCreditWindow,
  usageSummary,
} = require('../services/usage.service');
const oneGate = require('../services/onegate.service');
const paymentProvider = require('../services/paymentProvider.service');
const paystack = require('../services/paystack.service');
const { assertPlanChangeCapacity } = require('../services/planCapacity.service');
const { isValidEmail } = require('../utils/email');
const { clearApiCache } = require('../middleware/cache.middleware');

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const normalizedProfileText = (value) =>
  typeof value === 'string' ? value.trim() : null;

/**
 * Mock billing grants plans and credit packs without taking money. It needs
 * both an explicit opt-in and a non-production environment.
 *
 * `NODE_ENV !== 'production'` was the whole gate, so a staging deploy with no
 * payment provider handed out upgrades for free — and so did any box where
 * NODE_ENV happened to be unset, which is the default. Requiring the flag
 * makes that an active choice. Keeping the production check means setting the
 * flag by accident in production still cannot open it. See DECISIONS D-010.
 */
const mockBillingEnabled = () =>
  process.env.NODE_ENV !== 'production' &&
  String(process.env.BILLING_MOCK_ENABLED || '').trim().toLowerCase() === 'true';

const billingNotConfigured = (res) =>
  res.status(503).json({
    success: false,
    code: 'BILLING_PROVIDER_NOT_CONFIGURED',
    message: 'Card payments are not configured. Set PAYMENT_PROVIDER and its credentials before accepting paid plan or credit purchases.',
  });

const hostedPaymentResponse = ({ res, field, session, account, extra = {} }) => {
  const initializationStatus = session.initializationStatus || 'ready';
  const status = initializationStatus === 'initializing' ? 'initializing' : session.status;
  const payment = {
    provider: paymentProvider.providerName() || 'mock',
    reference: session.reference,
    amount: session.amount,
    currency: session.currency,
    status,
    ...extra,
    ...(initializationStatus === 'ready' && session.providerPaymentKey
      ? { paymentKey: session.providerPaymentKey }
      : {}),
    ...(initializationStatus === 'ready' && session.checkoutUrl
      ? { redirectUrl: session.checkoutUrl }
      : {}),
  };

  if (initializationStatus === 'initializing') {
    return res.status(202).json({
      success: true,
      code: 'PAYMENT_SESSION_INITIALIZING',
      [field]: payment,
      account,
    });
  }
  if (initializationStatus === 'failed') {
    return res.status(409).json({
      success: false,
      code: 'PAYMENT_SESSION_INITIALIZATION_FAILED',
      message: 'This payment session could not be initialized. Start again with a new Idempotency-Key.',
      [field]: payment,
      account,
    });
  }

  return res.status(200).json({ success: true, [field]: payment, account });
};

const buildAccountPayload = async (userId) => {
  const user = await User.findById(userId).select('-password -refreshTokens').lean();
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const org = await refreshCreditWindow(user.orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  const [activeSeatCount, pendingSeatCount, locationCount] = await Promise.all([
    User.countDocuments({ orgId: org._id }),
    TeamInvitation.countDocuments({
      orgId: org._id,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }),
    Cafe.countDocuments({ orgId: org._id, archivedAt: null }),
  ]);
  const seatCount = activeSeatCount + pendingSeatCount;

  const plan = getPlan(org.plan);
  const isOwner = user.role === 'owner';
  const credits = creditSnapshot(org);
  const access = billingAccessForOrganization(org);
  const usageLedger = await usageSummary(org._id);

  return {
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      cafeIds: user.cafeIds,
      activeCafeId: user.activeCafeId,
      emailVerified: user.emailVerified !== false,
      permissions: {
        canSpendCredits: user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
      },
    },
    organization: {
      _id: org._id,
      name: org.name,
      ownerId: org.ownerId,
      plan: normalisePlanId(org.plan),
      billingStatus: org.billingStatus,
      // billingStatus is what the customer bought; billingAccess is whether it
      // still grants access today. An elapsed trial or paid period leaves the
      // stored status reading "active" while every metered feature returns 402,
      // so the portal needs both to explain a lockout instead of showing a
      // green badge next to zero credits.
      billingAccess: {
        allowed: access.allowed,
        status: access.status,
        reason: access.reason || null,
        periodEnd: access.periodEnd || null,
      },
      billingCycle: org.billingCycle,
      ...(isOwner ? { billingEmail: org.billingEmail, paymentMethod: org.paymentMethod } : {}),
      trialStartedAt: org.trialStartedAt,
      trialEndsAt: org.trialEndsAt,
      subscriptionStartedAt: org.subscriptionStartedAt,
      currentPeriodStart: org.currentPeriodStart,
      currentPeriodEnd: org.currentPeriodEnd,
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      createdAt: org.createdAt,
    },
    usage: {
      seats: {
        used: seatCount,
        active: activeSeatCount,
        pending: pendingSeatCount,
        included: plan.includedSeats,
        remaining: Math.max(0, plan.includedSeats - seatCount),
      },
      locations: {
        used: locationCount,
        included: plan.includedLocations,
        remaining: Math.max(0, plan.includedLocations - locationCount),
      },
      aiCredits: credits,
      guavaCredits: credits,
      ...(isOwner ? { creditLedger: usageLedger } : {}),
    },
    plans: isOwner ? getPlans() : [],
  };
};

const getAccount = async (req, res, next) => {
  try {
    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({ success: true, account });
  } catch (error) {
    next(error);
  }
};

const getCreditBalance = async (req, res, next) => {
  try {
    let orgId = req.user.orgId;

    if (!orgId) {
      const user = await User.findById(req.user.id).select('orgId').lean();
      orgId = user?.orgId;
    }

    const org = await refreshCreditWindow(orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const plan = getPlan(org.plan);
    const access = billingAccessForOrganization(org);
    return res.status(200).json({
      success: true,
      credits: creditSnapshot(org),
      organization: {
        plan: normalisePlanId(org.plan),
        billingStatus: org.billingStatus,
        // See buildAccountPayload: the stored status alone cannot explain a
        // zero balance caused by an elapsed period.
        billingAccess: {
          allowed: access.allowed,
          status: access.status,
          reason: access.reason || null,
          periodEnd: access.periodEnd || null,
        },
        billingCycle: org.billingCycle,
        trialEndsAt: org.trialEndsAt,
        currentPeriodEnd: org.currentPeriodEnd,
      },
      plan: {
        id: plan.id,
        name: plan.name,
        includedGuavaCredits: plan.includedGuavaCredits ?? plan.includedAiCredits,
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  let session;
  try {
    const { name, organizationName, billingEmail } = req.body;
    const changesName = hasOwn(req.body, 'name');
    const changesOrganization = hasOwn(req.body, 'organizationName');
    const changesBillingEmail = hasOwn(req.body, 'billingEmail');
    if (!changesName && !changesOrganization && !changesBillingEmail) {
      return res.status(400).json({ success: false, message: 'No supported profile fields were provided' });
    }

    // Organization-level fields are owner-only; anyone can update their own name.
    if ((changesOrganization || changesBillingEmail) && req.user.role !== 'owner') {
      return res
        .status(403)
        .json({ success: false, message: 'Only the owner can change organization details' });
    }

    const cleanName = normalizedProfileText(name);
    const cleanOrganizationName = normalizedProfileText(organizationName);
    const cleanBillingEmail = normalizedProfileText(billingEmail)?.toLowerCase() || null;
    if (changesName && (!cleanName || cleanName.length < 2 || cleanName.length > 120)) {
      return res.status(400).json({ success: false, message: 'Name must be between 2 and 120 characters' });
    }
    if (
      changesOrganization &&
      (!cleanOrganizationName || cleanOrganizationName.length < 2 || cleanOrganizationName.length > 120)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Organization name must be between 2 and 120 characters',
      });
    }
    if (
      changesBillingEmail &&
      !isValidEmail(cleanBillingEmail)
    ) {
      return res.status(400).json({ success: false, message: 'Enter a valid billing email address' });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const user = await User.findById(req.user.id).session(session);
      if (!user) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }
      const org = await Organization.findById(user.orgId).session(session);
      if (!org) {
        const error = new Error('Organization not found');
        error.statusCode = 404;
        throw error;
      }

      if (changesName) user.name = cleanName;
      const previousOrgName = org.name;
      const previousBillingEmail = org.billingEmail;
      if (changesOrganization) org.name = cleanOrganizationName;
      if (changesBillingEmail) org.billingEmail = cleanBillingEmail;

      await user.save({ session });
      await org.save({ session });

      // identity-16: who controls the organisation's name and billing contact is audited like every other access change.
      const audits = [];
      if (changesOrganization && previousOrgName !== org.name) {
        audits.push({ action: 'org.renamed', details: { from: previousOrgName, to: org.name } });
      }
      if (changesBillingEmail && previousBillingEmail !== org.billingEmail) {
        audits.push({
          action: 'org.billing_email_changed',
          targetEmail: org.billingEmail,
          details: { from: previousBillingEmail || null, to: org.billingEmail },
        });
      }
      if (audits.length > 0) {
        await AccessAuditEvent.create(
          audits.map((audit) => ({ orgId: org._id, actorUserId: user._id, requestId: req.id, ...audit })),
          { session, ordered: true }
        );
      }
    });
    clearApiCache({ orgId: req.user.orgId });

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({ success: true, account });
  } catch (error) {
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const mockCheckout = async ({ req, org, selectedPlan, billingCycle, paymentMethod }) => {
  const planChanged = org.plan !== selectedPlan.id;
  const now = new Date();
  const period = billingPeriodForPayment(org, billingCycle, now);
  org.plan = selectedPlan.id;
  org.billingCycle = period.billingCycle;
  org.billingStatus = 'active';
  org.subscriptionStartedAt = org.subscriptionStartedAt || now;
  org.currentPeriodStart = period.currentPeriodStart;
  org.currentPeriodEnd = period.currentPeriodEnd;
  org.cancelAtPeriodEnd = false;
  org.mockCustomerId = org.mockCustomerId || `mock_cus_${org._id.toString().slice(-8)}`;
  org.paymentMethod = {
    brand: paymentMethod?.brand || 'visa',
    last4: paymentMethod?.last4 || '4242',
    expiresAt: paymentMethod?.expiresAt || '12/30',
    provider: 'mock',
  };
  const bonusUsed = bonusUsedForCredits(org);
  org.aiCredits = {
    included: selectedPlan.includedGuavaCredits ?? selectedPlan.includedAiCredits,
    bonus: org.aiCredits?.bonus || 0,
    bonusUsed,
    used: bonusUsed,
    // Same window rule as a real payment: one allowance per subscription month.
    resetAt: nextMonthlyAnniversary(period.currentPeriodStart, now),
  };
  await org.save();

  if (planChanged) {
    await invalidateFutureForecastsForOrg(org._id);
  }
  clearApiCache({ orgId: org._id });

  const account = await buildAccountPayload(req.user.id);
  return {
    checkout: {
      provider: 'mock',
      receiptId: `mock_rcpt_${Date.now()}`,
      amount: org.billingCycle === 'annual' ? selectedPlan.priceAnnual : selectedPlan.priceMonthly,
      currency: 'ZAR',
      status: 'paid',
    },
    account,
  };
};

const checkout = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly', paymentMethod } = req.body;
    const validPlanIds = new Set(getPlans().map((candidate) => candidate.id));
    if (!validPlanIds.has(plan)) {
      return res.status(400).json({ success: false, message: 'A valid billing plan is required' });
    }
    if (!['monthly', 'annual'].includes(billingCycle)) {
      return res.status(400).json({ success: false, message: 'billingCycle must be monthly or annual' });
    }
    const selectedPlan = getPlan(plan);

    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }
    await assertPlanChangeCapacity(org._id, org.plan, selectedPlan.id);

    if (paymentProvider.isHostedCheckoutEnabled()) {
      const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
      const amount = cycle === 'annual' ? selectedPlan.priceAnnual : selectedPlan.priceMonthly;
      const session = await createHostedPaymentSession({
        org,
        userId: req.user.id,
        kind: 'plan',
        plan: selectedPlan.id,
        billingCycle: cycle,
        amount,
        idempotencyKey: req.get('Idempotency-Key'),
      });

      const account = await buildAccountPayload(req.user.id);
      return hostedPaymentResponse({
        res,
        field: 'checkout',
        session,
        account,
      });
    }

    if (!mockBillingEnabled()) return billingNotConfigured(res);

    const { checkout: mock, account } = await mockCheckout({
      req,
      org,
      selectedPlan,
      billingCycle,
      paymentMethod,
    });

    return res.status(200).json({
      success: true,
      checkout: mock,
      account,
    });
  } catch (error) {
    if (error?.code === 'PLAN_LIMIT_EXCEEDED') {
      return res.status(409).json({
        success: false,
        code: error.code,
        message: error.message,
        capacity: error.details?.capacity,
      });
    }
    next(error);
  }
};

const buyAiCredits = async (req, res, next) => {
  try {
    const { credits = 500 } = req.body;

    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const requestedCredits = Number(credits);
    const availablePacks = getPlan(org.plan).creditPackOptions || [];
    if (!availablePacks.some((option) => option.credits === requestedCredits)) {
      return res.status(400).json({ success: false, message: 'Select a valid Guava Credit pack' });
    }
    const pack = getCreditPack(org, requestedCredits);
    const billingAccess = billingAccessForOrganization(org);
    if (!billingAccess.allowed) throw billingRequiredError(billingAccess);

    if (paymentProvider.isHostedCheckoutEnabled()) {
      const session = await createHostedPaymentSession({
        org,
        userId: req.user.id,
        kind: 'credits',
        credits: pack.credits,
        amount: pack.price,
        idempotencyKey: req.get('Idempotency-Key'),
      });

      const account = await buildAccountPayload(req.user.id);
      return hostedPaymentResponse({
        res,
        field: 'purchase',
        session,
        account,
        extra: { credits: pack.credits },
      });
    }

    if (!mockBillingEnabled()) return billingNotConfigured(res);

    await refreshCreditWindow(org._id);
    // Through the same reference-keyed fulfilment a real payment uses, rather
    // than a bare $inc: a replayed request must grant the pack once. The
    // receipt is the session reference, so it names a row that exists instead
    // of a timestamp that identifies nothing.
    const { session } = await fulfilMockCreditPurchase({
      org,
      userId: req.user.id,
      credits: pack.credits,
      amount: pack.price,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    clearApiCache({ orgId: org._id });

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({
      success: true,
      purchase: {
        provider: 'mock',
        receiptId: session.reference,
        credits: pack.credits,
        amount: pack.price,
        currency: 'ZAR',
        status: 'paid',
      },
      account,
    });
  } catch (error) {
    next(error);
  }
};

// Webhook bodies are unauthenticated and attacker-controlled. Each candidate is
// normalised to a string before use, so a query operator object can never reach
// a database filter.
const oneGateReferenceFromRequest = (req) =>
  normalizePaymentReference(req.body?.merchant_reference)
  || normalizePaymentReference(req.body?.reference)
  || normalizePaymentReference(req.query?.reference);

/**
 * Paystack sends the customer back here after checkout.
 *
 * Unlike the OneGate return, this verifies the reference server-side before
 * redirecting, so settlement never depends on an inbound webhook reaching this
 * machine. That is what lets card payments be tested without a public URL.
 * The browser's claim about the outcome is ignored entirely -- only the
 * verify call decides.
 */
const handlePaystackReturn = async (req, res) => {
  const reference = normalizePaymentReference(req.query.reference);
  let status = 'pending';

  if (reference) {
    try {
      const session = await reconcileOneGatePayment(reference);
      if (session?.status) status = session.status;
    } catch (error) {
      // A 202 means "not settled yet", which is a legitimate pending outcome.
      // Anything else still must not strand the customer on a blank page.
      if (error?.statusCode !== 202) {
        console.error('[billing] paystack return reconciliation failed:', error.message);
      }
      try {
        const session = await PaymentSession.findOne({ reference }).select('status').lean();
        if (session?.status) status = session.status;
      } catch (_lookupError) {
        status = 'pending';
      }
    }
  }

  return res.redirect(paystack.hostedCheckoutReturnUrl(status, reference));
};

/**
 * Optional robustness path for when the customer closes the tab before the
 * redirect. Paystack signs the raw body with HMAC-SHA512 using the secret key.
 */
const handlePaystackWebhook = async (req, res, next) => {
  try {
    const signature = req.get('x-paystack-signature');
    const secret = (process.env.PAYSTACK_SECRET_KEY || '').trim();
    if (!secret || !signature || !req.rawBody) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');
    if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) {
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const reference = normalizePaymentReference(req.body?.data?.reference);
    if (!reference) return res.status(200).json({ success: true });

    // Acknowledge regardless of outcome so Paystack does not retry a payment
    // this server has already recorded.
    try {
      await reconcileOneGatePayment(reference, {
        reference,
        status: req.body?.event,
      });
    } catch (error) {
      if (error?.statusCode !== 202) {
        console.error('[billing] paystack webhook reconciliation failed:', error.message);
      }
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    return next(error);
  }
};

const handleOneGateWebhook = async (req, res, next) => {
  try {
    const reference = oneGateReferenceFromRequest(req);
    if (!reference) {
      return res.status(400).json({ success: false, message: 'Missing payment reference' });
    }

    // The route is unauthenticated and the callback carries no signature, so a
    // forged notification must not be able to tell its sender whether a
    // reference exists. Fulfilment itself is safe -- the amount and status come
    // from the outbound provider lookup, never from this body -- so every
    // outcome, including an unknown reference, is acknowledged identically.
    try {
      await reconcileOneGatePayment(reference, req.body);
    } catch (error) {
      if (![202, 404, 400].includes(error?.statusCode)) {
        console.error('[billing] onegate webhook reconciliation failed:', error.message);
      }
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

const handleOneGateReturn = async (req, res) => {
  // Defence in depth, matching every other reference entry point: an array or
  // an object from the query string must never reach a database filter.
  const reference = normalizePaymentReference(req.query.reference);
  const requestedResult = req.query.result;
  let status = requestedResult === 'cancel' ? 'cancelled' : 'pending';

  if (reference) {
    try {
      const session = await PaymentSession.findOne({ reference }).select('status').lean();
      if (session?.status === 'paid') status = 'paid';
      else if (['failed', 'cancelled'].includes(session?.status)) status = session.status;
      else if (requestedResult === 'error') status = 'failed';
    } catch (_error) {
      status = requestedResult === 'error' ? 'failed' : status;
    }
  }

  return res.redirect(oneGate.hostedCheckoutReturnUrl(status, reference));
};

const getPaymentStatus = async (req, res, next) => {
  try {
    const { reference } = req.params;
    const session = await PaymentSession.findOne({ reference, orgId: req.user.orgId });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Payment session not found' });
    }

    return res.status(200).json({
      success: true,
      payment: {
        reference: session.reference,
        provider: session.provider,
        kind: session.kind,
          status: session.status,
          initializationStatus: session.initializationStatus || 'ready',
        amount: session.amount,
        currency: session.currency,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  buyAiCredits,
  checkout,
  getAccount,
  getCreditBalance,
  getPaymentStatus,
  handleOneGateReturn,
  handleOneGateWebhook,
  handlePaystackReturn,
  handlePaystackWebhook,
  mockCheckout: checkout,
  updateProfile,
};
