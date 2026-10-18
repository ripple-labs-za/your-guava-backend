const mongoose = require('mongoose');

const shiftSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Staff',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    hoursWorked: {
      type: Number,
    },
    regularHours: {
      type: Number,
      min: 0,
      default: 0,
    },
    overtimeHours: {
      type: Number,
      min: 0,
      default: 0,
    },
    type: {
      type: String,
      enum: ['regular', 'overtime'],
      default: 'regular',
    },
    status: {
      type: String,
      enum: ['scheduled', 'completed', 'cancelled'],
      default: 'scheduled',
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  { timestamps: true }
);

shiftSchema.index({ cafeId: 1, date: 1 });

module.exports = mongoose.model('Shift', shiftSchema);
