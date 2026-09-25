const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    uploadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Upload',
    },
    receiptId: { type: String },
    dedupKey: { type: String },
    date: { type: Date, required: true },
    hour: { type: Number },
    // False when the export had dates but no times: `hour` is then null, and hour-of-day views leave the sale out.
    hourKnown: { type: Boolean, default: true },
    dayOfWeek: { type: Number },
    status: {
      type: String,
      enum: ['approved', 'declined', 'error', 'aborted'],
      default: 'approved',
    },
    paymentMethod: { type: String },
    items: [
      {
        salesItemId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Item',
        },
        name: { type: String, required: true },
        rawName: { type: String },
        quantity: { type: Number, required: true },
        unitPrice: { type: Number },
        // Where unitPrice came from. 'exact' is a price the till actually
        // recorded for this line; 'derived' is a basket average spread over a
        // multi-item packed receipt, kept so revenue sums but never learned as
        // a price. Rows written before the flag existed default to exact: the
        // API sync and manual writers only ever store real line prices, and a
        // 'derived' default would have discarded those from price learning.
        priceSource: { type: String, enum: ['exact', 'derived'], default: 'exact' },
        expectedPrice: { type: Number },
        priceVariancePct: { type: Number },
        menuItemStatus: {
          type: String,
          enum: ['matched', 'needs_review', 'price_mismatch', 'ignored'],
          default: 'matched',
        },
      },
    ],
    total: { type: Number },
    tip: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ['csv', 'api', 'manual'],
      default: 'csv',
    },
  },
  { timestamps: true }
);

// Sparse-unique compound indexes — at most one of receiptId/dedupKey should be set per row.
// Receipt numbers are unique per trading day, not globally: plenty of tills
// restart their order numbers each morning, so "#0001" recurs daily. Keyed on
// the receipt alone, the second day's sale collided with the first and the
// import was refused. The date is part of the identity.
transactionSchema.index(
  { cafeId: 1, receiptId: 1, date: 1 },
  { unique: true, partialFilterExpression: { receiptId: { $type: 'string' } } }
);
transactionSchema.index(
  { cafeId: 1, dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } }
);
// Every query leads with cafeId, so single-field cafeId, uploadId and date indexes cost ~20,000 index writes per
// 10,000-row import and served nothing (gap-6, BE-03-T13); align-import-indexes drops them from existing databases.
transactionSchema.index({ cafeId: 1, date: -1 });
transactionSchema.index({ cafeId: 1, uploadId: 1, date: -1 }); // the upload Rows view: its page, newest first, without a sort
transactionSchema.index({ cafeId: 1, status: 1, date: -1 });
transactionSchema.index({ cafeId: 1, status: 1, dayOfWeek: 1, date: -1 });
transactionSchema.index({ cafeId: 1, status: 1, dayOfWeek: 1, hour: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
