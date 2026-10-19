const logger = require('../utils/logger');
const { isProductionEnv } = require('../config/posture');
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
} = require('../services/billingPlans.service');
const {
  planChangeForPayment,
  previewPlanChanges, serialisePlanChange, formatBillingDate,
  createHostedPaymentSession,
  fulfilMockPayment,
  getCreditPack,
  invalidateFutureForecastsForOrg,
  reconcilePayment,
  normalizePaymentReference,
} = require('../services/billingPayments.service');
const {
  billingAccessForOrganization,
  billingRequiredError,
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
  !isProductionEnv() &&
  String(process.env.BILLING_MOCK_ENABLED || '').trim().toLowerCase() === 'true';

/** The active card-payment provider, visible to every account role. */
const activeBillingProvider = () => {
  if (paymentProvider.isHostedCheckoutEnabled()) return paymentProvider.providerName();
  return mockBillingEnabled() ? 'mock' : null;
};

const billingNotConfigured = (res) =>
  res.status(503).json({
    success: false,
    code: 'BILLING_PROVIDER_NOT_CONFIGURED',
    message: 'Card payments are not configured. Set PAYMENT_PROVIDER and its credentials before accepting paid plan or credit purchases.',
  });

const planChangeAlreadyScheduled = (res, pending) => {
  const planName = getPlan(pending.plan).name;
  return res.status(409).json({
    success: false,
    code: 'PLAN_CHANGE_ALREADY_SCHEDULED',
    message: `${planName} (${pending.billingCycle}) is already paid for and starts on ` +
      `${formatBillingDate(pending.effectiveAt)}. You can change plan again after it starts.`,
    pendingPlanChange: {
      plan: pending.plan,
      billingCycle: pending.billingCycle,
      effectiveAt: pending.effectiveAt,
      periodEnd: pending.periodEnd,
    },
  });
};

const hostedPaymentResponse = ({ res, field, session, account, extra = {} }) => {
  const initializationStatus = session.initializationStatus || 'ready';
  const status = initializationStatus === 'initializing' ? 'initializing' : session.status;
  const payment = {
    provider: session.provider || paymentProvider.providerName() || 'mock',
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
  const user = await User.findById(userId).select('-password').lean();
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
  const usageLedger = isOwner ? await usageSummary(org._id) : null;

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
        readOnly: Boolean(access.readOnly),
        graceEndsAt: access.graceEndsAt || null,
      },
      billingCycle: org.billingCycle,
      ...(isOwner ? { billingEmail: org.billingEmail, paymentMethod: org.paymentMethod } : {}),
      trialStartedAt: org.trialStartedAt,
      trialEndsAt: org.trialEndsAt,
      subscriptionStartedAt: org.subscriptionStartedAt,
      currentPeriodStart: org.currentPeriodStart,
      currentPeriodEnd: org.currentPeriodEnd,
      cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      pendingPlanChange: org.pendingPlanChange
        ? {
            plan: org.pendingPlanChange.plan,
            billingCycle: org.pendingPlanChange.billingCycle,
            effectiveAt: org.pendingPlanChange.effectiveAt,
            periodEnd: org.pendingPlanChange.periodEnd,
          }
        : null,

      createdAt: org.createdAt,
    },
    billing: { provider: activeBillingProvider() },
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
    planChanges: isOwner ? previewPlanChanges(org) : [],
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
    const orgId = req.user.orgId;


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
          readOnly: Boolean(access.readOnly),
          graceEndsAt: access.graceEndsAt || null,
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
  const amount = billingCycle === 'annual' ? selectedPlan.priceAnnual : selectedPlan.priceMonthly;
  const { session, planChanged, change } = await fulfilMockPayment({
    org, userId: req.user.id, kind: 'plan', plan: selectedPlan.id,
    billingCycle, amount, idempotencyKey: req.get('Idempotency-Key'), paymentMethod,
  });
  await Organization.updateOne(
    { _id: org._id, mockCustomerId: { $exists: false } },
    {
      $set: {
        mockCustomerId: org.mockCustomerId || `mock_cus_${org._id.toString().slice(-8)}`,
      },
    }
  );
  if (planChanged) await invalidateFutureForecastsForOrg(org._id);
  clearApiCache({ orgId: org._id }); // BE-04-T05 scoped form (bare throws); keep one call, do not add a second
  const account = await buildAccountPayload(req.user.id);
  return {
    checkout: {
      provider: 'mock',
      reference: session.reference,
      receiptId: session.reference,
      amount,
      currency: 'ZAR',
      status: 'paid',
      planChange: change ? serialisePlanChange(change) : null,
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
    const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
    // A retry of an already-paid mock session is a receipt lookup, even when
    // that very payment scheduled a change. New payments still get the early 409.
    const mockKey = !paymentProvider.isHostedCheckoutEnabled() && mockBillingEnabled()
      && typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key').trim() : null;
    const mockReplay = mockKey && await PaymentSession.findOne({
      orgId: org._id, kind: 'plan', provider: 'mock', status: 'paid', idempotencyKey: mockKey,
    }).lean();
    if (mockReplay) {
      const result = await mockCheckout({ req, org, selectedPlan, billingCycle: cycle, paymentMethod });
      return res.status(200).json({ success: true, ...result });
    }
    if (org.pendingPlanChange?.effectiveAt) return planChangeAlreadyScheduled(res, org.pendingPlanChange);
    const planChange = serialisePlanChange(planChangeForPayment(org, { plan: selectedPlan.id, billingCycle: cycle }));
    await assertPlanChangeCapacity(org._id, org.plan, selectedPlan.id);

    if (paymentProvider.isHostedCheckoutEnabled()) {
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
        extra: { planChange },
      });
    }

    if (!mockBillingEnabled()) return billingNotConfigured(res);

    const { checkout: mock, account } = await mockCheckout({
      req,
      org,
      selectedPlan,
      billingCycle: cycle,
      paymentMethod,
    });

    return res.status(200).json({
      success: true,
      checkout: mock,
      account,
    });
  } catch (error) {
    if (error?.code === 'PLAN_CHANGE_ALREADY_SCHEDULED') {
      const fresh = await Organization.findById(req.user.orgId).lean();
      if (fresh?.pendingPlanChange) return planChangeAlreadyScheduled(res, fresh.pendingPlanChange);
    }
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
    const { session } = await fulfilMockPayment({
      org,
      kind: 'credits',
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
      const session = await reconcilePayment(reference);
      if (session?.status) status = session.status;
    } catch (error) {
      // A 202 means "not settled yet", which is a legitimate pending outcome.
      // Anything else still must not strand the customer on a blank page.
      if (error?.statusCode !== 202) {
        logger.error('payment_return_reconcile_failed', { provider: 'paystack', reference, requestId: req.id, ...logger.errorFields(error) });
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

    const data = req.body?.data || {};
    const reference = normalizePaymentReference(data.reference)
      || normalizePaymentReference(data.transaction_reference)
      || normalizePaymentReference(data.transaction?.reference);
    if (!reference) return res.status(200).json({ success: true });

    const event = typeof req.body?.event === 'string' ? req.body.event.slice(0, 64) : '';
    try {
      await reconcilePayment(reference, { reference, status: event }, {
        recheckPaid: /^(refund\.|charge\.dispute\.)/.test(event),
      });
    } catch (error) {
      if (![202, 400, 404].includes(error?.statusCode)) {
        logger.error('payment_webhook_reconcile_failed', { provider: 'paystack', reference, providerEvent: event, requestId: req.id, ...logger.errorFields(error) });
        return res.status(500).json({ success: false, message: 'Reconciliation failed; retry later' });
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
      await reconcilePayment(reference, req.body);
    } catch (error) {
      if (![202, 404, 400].includes(error?.statusCode)) {
        logger.error('payment_webhook_reconcile_failed', { provider: 'onegate', reference, requestId: req.id, ...logger.errorFields(error) });
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
        planChangeConflict: session.status === 'needs_attention' && session.kind === 'plan'
          && /already scheduled/i.test(String(session.providerReason || '')),
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
  updateProfile,
};
