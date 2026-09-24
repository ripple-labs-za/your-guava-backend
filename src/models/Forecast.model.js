const mongoose = require('mongoose');

const factorSchema = new mongoose.Schema(
  {
    key: { type: String },
    label: { type: String },
    active: { type: Boolean, default: false },
    adjustmentPct: { type: Number },
    multiplier: { type: Number },
    effect: { type: String },
    reason: { type: String },
  },
  { _id: false }
);

const calibrationEntrySchema = new mongoose.Schema(
  {
    key: { type: String },
    label: { type: String },
    itemName: { type: String },
    multiplier: { type: Number },
    sampleSize: { type: Number },
    averageRatio: { type: Number },
  },
  { _id: false }
);

const forecastEventSchema = new mongoose.Schema(
  {
    name: { type: String },
    type: {
      type: String,
      enum: ['event', 'closure', 'partial_closure'],
      default: 'event',
    },
    impact: { type: String },
    impactPct: { type: Number },
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
  },
  { _id: false }
);

const forecastSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    // Calendar date in the cafe's timezone. API consumers must use this field
    // for labels and grouping rather than deriving a date from the UTC instant.
    dateKey: {
      type: String,
      match: /^\d{4}-\d{2}-\d{2}$/,
      index: true,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    origin: {
      type: String,
      enum: ['live', 'backfill', 'manual'],
      default: 'live',
      index: true,
    },
    modelVersion: {
      type: String,
      default: 'legacy',
    },
    trainingCutoff: {
      type: Date,
    },
    availability: {
      // True when the day is configured closed but the weekday has sales history.
      contradictsHistory: { type: Boolean, default: false },
      status: {
        type: String,
        enum: ['ready', 'insufficient_data', 'closed'],
        default: 'ready',
      },
      reason: { type: String },
    },
    items: [
      {
        itemName: { type: String },
        baseQty: { type: Number },
        predictedQty: { type: Number },
        // How much weight this single item's number can bear. Driven by volume:
        // low-volume lines are dominated by day-to-day randomness.
        confidence: { type: String, enum: ['high', 'medium', 'low'], default: 'low' },
        actualQty: { type: Number },
        suggestedStock: { type: Number },
        factors: [factorSchema],
      },
    ],
    signals: {
      weather: {
        available: { type: Boolean },
        temp: { type: Number },
        condition: { type: String },
        humidity: { type: Number },
        isRain: { type: Boolean },
        precipMm: { type: Number },
        chanceOfRain: { type: Number },
        unavailableReason: { type: String },
      },
      loadSheddingStage: { type: Number },
      loadSheddingAvailable: { type: Boolean },
      loadSheddingUnavailableReason: { type: String },
      isPublicHoliday: { type: Boolean, default: false },
      isSchoolHoliday: { type: Boolean, default: false },
      isPayday: { type: Boolean, default: false },
      dayOfWeek: { type: Number },
      events: [forecastEventSchema],
    },
    factors: [factorSchema],
    factorSettings: {
      type: mongoose.Schema.Types.Mixed,
    },
    factorEntitlements: {
      type: mongoose.Schema.Types.Mixed,
    },
    calibration: {
      lookbackDays: { type: Number },
      sampleSize: { type: Number },
      overallMultiplier: { type: Number },
      factorMultipliers: [calibrationEntrySchema],
      itemMultipliers: [calibrationEntrySchema],
      generatedAt: { type: Date },
    },
    totalPredictedRevenue: {
      type: Number,
    },
    forecastCoverage: {
      itemCount: { type: Number, default: 0 },
      storedItemCount: { type: Number, default: 0 },
      totalPredictedQty: { type: Number, default: 0 },
      includesAllRevenue: { type: Boolean, default: false },
      accuracyMethod: { type: String },
      // Every item this forecast predicted, not only the stored top items: scoring a day after the owner ignored a line
      // keeps counting it when the forecast predicted it (BE-03-T11). Kept out of API payloads; actuals select it.
      predictedItemNames: { type: [String], select: false, default: undefined },
    },
    actualRevenue: {
      type: Number,
    },
    actualTransactionCount: {
      type: Number,
    },
    actualsUpdatedAt: {
      type: Date,
    },
    accuracy: {
      type: Number, // percentage, populated after actuals come in
    },
    trainingData: {
      transactionCount: { type: Number, default: 0 },
      firstTransactionDate: { type: Date },
      lastTransactionDate: { type: Date },
      weeksWithSales: { type: Number, default: 0 },
      observedWeeks: { type: Number, default: 0 },
      missingWeeks: { type: Number, default: 0 },
      staleDays: { type: Number },
    },
  },
  { timestamps: true }
);

forecastSchema.index({ cafeId: 1, date: 1 }, { unique: true });
forecastSchema.index({ cafeId: 1, dateKey: 1 });
forecastSchema.index({ cafeId: 1, 'items.itemName': 1, date: -1 });

module.exports = mongoose.model('Forecast', forecastSchema);
