const mongoose = require('mongoose');

const paymentSessionSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    provider: {
      type: String,
      // Must stay in step with paymentProvider.service PROVIDERS: the session
      // is written with providerName(), so a name the resolver can select but
      // the schema rejects fails every checkout at creation.
      enum: ['mock', 'onegate', 'paystack'],
      required: true,
      default: 'onegate',
    },
    kind: {
      type: String,
      enum: ['plan', 'credits'],
      required: true,
    },
    idempotencyKey: {
      type: String,
      maxlength: 160,
    },
    requestFingerprint: {
      type: String,
      maxlength: 64,
    },
    initializationStatus: {
      type: String,
      enum: ['initializing', 'ready', 'failed'],
      default: 'ready',
      index: true,
    },
    initializationStartedAt: {
      type: Date,
    },
    initializationAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      // `needs_attention` is a captured payment that repeatedly could not be
      // applied. It is terminal on purpose: retrying forever hides money that
      // was taken with nothing delivered, so the session stops rotating through
      // the sweeper and waits for a person instead.
      // A reversed capture is terminal and is never claimed for fulfilment again.
      enum: ['pending', 'processing', 'paid', 'failed', 'cancelled', 'needs_attention', 'reversed'],
      default: 'pending',
      index: true,
    },
    reference: {
      type: String,
      required: true,
      unique: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'ZAR',
    },
    plan: {
      type: String,
      enum: ['starter', 'growth', 'pro'],
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'annual'],
    },
    credits: {
      type: Number,
    },
    providerPaymentKey: {
      type: String,
    },
    providerTransactionId: {
      type: String,
    },
    gatewayReference: {
      type: String,
    },
    checkoutUrl: {
      type: String,
    },
    redirectOrigin: {
      type: String,
    },
    providerStatus: {
      type: String,
    },
    providerReason: {
      type: String,
    },
    providerPayload: {
      type: mongoose.Schema.Types.Mixed,
    },
    paidAt: {
      type: Date,
    },
    reversedAt: { type: Date },
    // Display metadata only.
    card: {
      type: new mongoose.Schema({ brand: String, last4: String }, { _id: false }),
      default: undefined,
    },
    failedAt: {
      type: Date,
    },
    processingStartedAt: {
      type: Date,
    },
    fulfillmentAttempts: {
      type: Number,
      default: 0,
    },
    // Counts only the attempts where the provider confirmed a capture and
    // applying it still failed. Kept apart from fulfillmentAttempts, which also
    // counts the ordinary "customer has not paid yet" verifications.
    fulfillmentFailures: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

paymentSessionSchema.index(
  { provider: 1, providerTransactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerTransactionId: { $type: 'string' } },
  }
);
paymentSessionSchema.index(
  { orgId: 1, kind: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);
paymentSessionSchema.index({ provider: 1, initializationStatus: 1, status: 1, updatedAt: 1 });

module.exports = mongoose.model('PaymentSession', paymentSessionSchema);
