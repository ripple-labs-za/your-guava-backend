// Hosted payment sessions: idempotency, references, initiation and creation, credit packs.
// Moved from billingPayments.service.js by BE-11-T04; behaviour unchanged.
const crypto = require('crypto');
const PaymentSession = require('../../models/PaymentSession.model');
const User = require('../../models/User.model');
const { getPlan } = require('../billingPlans.service');
const paymentProvider = require('../paymentProvider.service');
const { isValidEmail } = require('../../utils/email');

const INITIALIZATION_LEASE_MS = 60 * 1000;

const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

const paymentInitiationError = (message, code, statusCode = 400, details = {}) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.details = { code, ...details };
  return err;
};

const normalizePaymentIdempotencyKey = (value) => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    throw paymentInitiationError(
      'Idempotency-Key is required for card payment requests',
      'PAYMENT_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) {
    throw paymentInitiationError(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} printable characters`,
      'PAYMENT_IDEMPOTENCY_KEY_INVALID'
    );
  }
  return key;
};

const paymentRequestFingerprint = ({ kind, plan, billingCycle, credits, amount }) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({
      kind,
      plan: plan || null,
      billingCycle: billingCycle || null,
      credits: credits == null ? null : Number(credits),
      amount: Number(amount || 0).toFixed(2),
      currency: 'ZAR',
    }))
    .digest('hex');

const generateReference = (kind = 'plan') => {
  const marker = kind === 'credits' ? 'C' : 'P';
  return `GG${marker}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
};

const paymentSessionNotFound = () => {
  const err = new Error('Payment session not found');
  err.statusCode = 404;
  return err;
};

/**
 * Coerces a payment reference from an untrusted source into a plain string.
 *
 * References arrive on unauthenticated webhook routes and are used to build a
 * Mongoose filter. Mongoose reads an object containing $ operators as query
 * syntax rather than a value to cast, so a body of {"merchant_reference":
 * {"$ne": null}} selected an arbitrary PaymentSession belonging to any tenant.
 * Anything that is not a sane non-empty string is refused outright.
 */
const MAX_REFERENCE_LENGTH = 128;

const normalizePaymentReference = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REFERENCE_LENGTH) return null;
  return trimmed;
};

const invalidPaymentReference = () => {
  const err = new Error('A valid payment reference is required');
  err.statusCode = 400;
  return err;
};

const initializeHostedPaymentSession = async (paymentSession, org) => {
  const leaseStartedAt = new Date(paymentSession.initializationStartedAt);
  try {
    const provider = paymentProvider.requireProvider();
    // Receipts go to the billing contact. Normalize raw legacy data as well as
    // documents written through the schema's lowercase/trim setters.
    const billingEmail = typeof org.billingEmail === 'string' ? org.billingEmail.trim().toLowerCase() : '';
    const email = provider.requiresCustomerEmail
      ? (isValidEmail(billingEmail) ? billingEmail : (await User.findById(paymentSession.userId).select('email').lean())?.email)
      : undefined;

    const paymentKey = await provider.createPaymentKey({
      reference: paymentSession.reference,
      amount: paymentSession.amount,
      customerReference: org.name,
      email,
    });

    const ready = await PaymentSession.findOneAndUpdate(
      {
        _id: paymentSession._id,
        initializationStatus: 'initializing',
        initializationStartedAt: leaseStartedAt,
      },
      {
        $set: {
          initializationStatus: 'ready',
          providerPaymentKey: paymentKey.key,
          checkoutUrl: paymentKey.url,
          redirectOrigin: paymentKey.origin,
          providerPayload: {
            paymentKey: { key: paymentKey.key, url: paymentKey.url, origin: paymentKey.origin },
          },
        },
        $unset: { failedAt: 1, providerReason: 1 },
      },
      { new: true, runValidators: true }
    );
    return ready || PaymentSession.findById(paymentSession._id);
  } catch (error) {
    const failed = await PaymentSession.findOneAndUpdate(
      {
        _id: paymentSession._id,
        initializationStatus: 'initializing',
        initializationStartedAt: leaseStartedAt,
      },
      {
        $set: {
          initializationStatus: 'failed',
          status: 'failed',
          failedAt: new Date(),
          providerReason: String(error.message || 'Checkout initialization failed').slice(0, 500),
        },
      },
      { new: true, runValidators: true }
    );
    // A newer request may have reclaimed an expired initialization lease. The
    // older worker must not overwrite that attempt with its own result.
    if (!failed) return PaymentSession.findById(paymentSession._id);
    throw error;
  }
};

const createHostedPaymentSession = async ({
  org,
  userId,
  kind,
  plan,
  billingCycle,
  credits,
  amount,
  idempotencyKey,
}) => {
  if (!paymentProvider.isHostedCheckoutConfigured()) {
    const err = new Error('Card payments are not configured');
    err.statusCode = 503;
    throw err;
  }

  const key = normalizePaymentIdempotencyKey(idempotencyKey);
  const requestFingerprint = paymentRequestFingerprint({
    kind,
    plan,
    billingCycle,
    credits,
    amount,
  });
  const reference = generateReference(kind);
  const initializationStartedAt = new Date();
  let paymentSession;
  try {
    paymentSession = await PaymentSession.create({
      orgId: org._id,
      userId,
      provider: paymentProvider.providerName(),
      kind,
      idempotencyKey: key,
      requestFingerprint,
      initializationStatus: 'initializing',
      initializationStartedAt,
      initializationAttempts: 1,
      reference,
      amount,
      currency: 'ZAR',
      plan,
      billingCycle,
      credits,
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await PaymentSession.findOne({
      orgId: org._id,
      kind,
      idempotencyKey: key,
    });
    if (!existing) throw error;
    const existingFingerprint = existing.requestFingerprint || paymentRequestFingerprint(existing);
    if (existingFingerprint !== requestFingerprint) {
      throw paymentInitiationError(
        'Idempotency-Key was already used for a different payment request',
        'PAYMENT_IDEMPOTENCY_CONFLICT',
        409,
        { reference: existing.reference }
      );
    }
    const staleBefore = new Date(Date.now() - INITIALIZATION_LEASE_MS);
    paymentSession = await PaymentSession.findOneAndUpdate(
      {
        _id: existing._id,
        initializationStatus: 'initializing',
        $or: [
          { initializationStartedAt: { $lte: staleBefore } },
          {
            initializationStartedAt: { $exists: false },
            createdAt: { $lte: staleBefore },
          },
        ],
      },
      {
        $set: { initializationStartedAt: new Date() },
        $unset: { failedAt: 1, providerReason: 1 },
        $inc: { initializationAttempts: 1 },
      },
      { new: true, runValidators: true }
    );
    if (!paymentSession) return PaymentSession.findById(existing._id);
  }

  return initializeHostedPaymentSession(paymentSession, org);
};

const getCreditPack = (org, requestedCredits) => {
  const plan = getPlan(org.plan);
  const pack = (plan.creditPackOptions || []).find((option) => option.credits === Number(requestedCredits));
  if (pack) return pack;

  return (plan.creditPackOptions || [])[0] || {
    credits: 500,
    price: plan.guavaCreditPackPrice || plan.aiCreditPackPrice || 99,
  };
};

module.exports = {
  paymentInitiationError, normalizePaymentIdempotencyKey, paymentRequestFingerprint, generateReference, paymentSessionNotFound, normalizePaymentReference,
  invalidPaymentReference, initializeHostedPaymentSession, createHostedPaymentSession, getCreditPack,
};
