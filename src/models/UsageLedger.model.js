const mongoose = require('mongoose');

const usageLedgerSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    featureKey: {
      type: String,
      required: true,
    },
    label: {
      type: String,
      required: true,
    },
    credits: {
      type: Number,
      required: true,
      min: 0,
    },
    creditAllocation: {
      included: {
        type: Number,
        default: 0,
        min: 0,
      },
      bonus: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    status: {
      type: String,
      enum: ['reserved', 'recovering', 'committed', 'refunded', 'failed'],
      default: 'committed',
    },
    provider: {
      type: String,
      default: 'guava',
    },
    relatedEntity: {
      kind: String,
      id: String,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    resultPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    providerDiagnostics: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    idempotencyKey: {
      type: String,
      maxlength: 160,
    },
    requestFingerprint: {
      type: String,
      maxlength: 64,
    },
    replayCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Provider-consuming refunded attempts still count against AI safety caps (D-015).
    providerConsumedRuns: {
      type: Number,
      min: 0,
      default: undefined,
    },
    recoveryReason: {
      type: String,
      maxlength: 120,
    },
    reservedAt: {
      type: Date,
    },
    creditWindowResetAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

usageLedgerSchema.index({ orgId: 1, createdAt: -1 });
usageLedgerSchema.index({ status: 1, reservedAt: 1 });
// The AI safety-budget check runs inside the reservation transaction on every
// paid request. Both of its rolling 24-hour windows are served from here, so
// latency stays flat instead of growing with an organisation's lifetime usage.
usageLedgerSchema.index({ orgId: 1, status: 1, reservedAt: -1 });
usageLedgerSchema.index({ orgId: 1, userId: 1, status: 1, reservedAt: -1 });
usageLedgerSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);

module.exports = mongoose.model('UsageLedger', usageLedgerSchema);
