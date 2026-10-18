const mongoose = require('mongoose');
const { storedDayKey } = require('../utils/timezone');

const eventSchema = new mongoose.Schema(
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
      minlength: 2,
      maxlength: 160,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    dateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    type: {
      type: String,
      enum: ['event', 'closure', 'partial_closure'],
      default: 'event',
      index: true,
    },
    closureWindow: {
      type: new mongoose.Schema(
        {
          startTime: { type: String },
          endTime: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    impact: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    impactPct: {
      type: Number,
      min: -90,
      max: 200,
    },
    notes: {
      type: String,
      maxlength: 2000,
    },
    recurring: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

eventSchema.index({ cafeId: 1, date: 1 });
eventSchema.index({ cafeId: 1, dateKey: 1 });
eventSchema.index({ cafeId: 1, recurring: 1 });

eventSchema.pre('validate', function fillDateKeyFromNominalDate() {
  if (this.dateKey || !(this.date instanceof Date)) return;
  const date = this.date;
  if (date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds() || date.getUTCMilliseconds()) return;
  this.dateKey = storedDayKey(date, 'UTC');
});

module.exports = mongoose.model('Event', eventSchema);
