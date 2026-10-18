const mongoose = require('mongoose');

const staffSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    phone: {
      type: String,
      trim: true,
      maxlength: 30,
    },
    role: {
      type: String,
      enum: ['barista', 'kitchen', 'front', 'manager', 'other'],
      default: 'barista',
    },
    hourlyRate: {
      type: Number,
      required: true,
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    // The days of the week this person normally works: 0 Sunday … 6 Saturday.
    // Leave is charged only on these days (BE-08-T03, D-014).
    workDays: {
      type: [{ type: Number, min: 0, max: 6 }],
      default: () => [1, 2, 3, 4, 5],
      validate: {
        validator: (days) => Array.isArray(days) && days.length > 0 && days.every(Number.isInteger),
        message: 'workDays must list at least one day from 0 (Sunday) to 6 (Saturday)',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Staff', staffSchema);
