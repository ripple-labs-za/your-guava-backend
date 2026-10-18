const mongoose = require('mongoose');

// One entry per owner adjustment: who changed which cycle's total, from what,
// to what, and why. It is the audit record D-014 requires.
const adjustmentSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['annual', 'sick', 'family'], required: true },
    cycleStart: { type: Date, required: true },
    previousTotal: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0, max: 366 },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true },
  },
  { _id: false }
);

const leaveBalanceSchema = new mongoose.Schema(
  {
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Staff',
      required: true,
      unique: true,
    },
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    // Per-cycle default entitlement. Used days are not stored: they are derived
    // from approved LeaveRequests in the cycle (services/workforce/leaveCycles.js).
    annual: { total: { type: Number, default: 15 } },
    sick: { total: { type: Number, default: 30 } },
    family: { total: { type: Number, default: 3 } },
    adjustments: { type: [adjustmentSchema], default: [] },
    // Incremented by lockLeaveBalance to serialise balance-dependent writes.
    revision: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LeaveBalance', leaveBalanceSchema);
