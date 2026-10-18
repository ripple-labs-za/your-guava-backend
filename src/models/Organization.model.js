const mongoose = require('mongoose');

const DEFAULT_TRIAL_DAYS = 14;
const trialEnd = () => new Date(Date.now() + DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000);

const paymentMethodSchema = new mongoose.Schema(
  {
    brand: String,
    last4: String,
    expiresAt: String,
    provider: String,
  },
  { _id: false }
);

// D-019: a downgrade or cycle switch is paid now and starts when the current term ends.
const pendingPlanChangeSchema = new mongoose.Schema(
  {
    plan: { type: String, enum: ['starter', 'growth', 'pro'], required: true },
    billingCycle: { type: String, enum: ['monthly', 'annual'], required: true },
    effectiveAt: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    reference: { type: String, required: true },
    scheduledAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: String,
      enum: ['free', 'starter', 'growth', 'pro'],
      default: 'starter',
    },
    billingStatus: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'canceled'],
      default: 'trialing',
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'annual'],
      default: 'monthly',
    },
    billingEmail: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    mockCustomerId: {
      type: String,
    },
    paymentMethod: {
      type: paymentMethodSchema,
      default: undefined,
    },
    aiCredits: {
      included: { type: Number, default: 400 },
      bonus: { type: Number, default: 0 },
      // No schema default: an absent value identifies legacy documents so the
      // service can infer historical bonus usage from the combined counter.
      bonusUsed: { type: Number, min: 0 },
      used: { type: Number, default: 0 },
      resetAt: {
        type: Date,
        default: trialEnd,
      },
    },
    trialStartedAt: {
      type: Date,
      default: Date.now,
    },
    trialEndsAt: {
      type: Date,
      default: trialEnd,
      index: true,
    },
    subscriptionStartedAt: {
      type: Date,
    },
    currentPeriodStart: {
      type: Date,
    },
    currentPeriodEnd: {
      type: Date,
      index: true,
    },
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    pendingPlanChange: { type: pendingPlanChangeSchema, default: undefined },
    billingRemindersSent: { type: [String], default: undefined, select: false },
    fulfilledPaymentReferences: {
      type: [String],
      default: [],
      select: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
