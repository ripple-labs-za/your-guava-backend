const mongoose = require('mongoose');

const columnMappingSchema = new mongoose.Schema(
  {
    receiptId: { type: String },
    date: { type: String },
    time: { type: String },
    items: { type: String },
    total: { type: String },
    tip: { type: String },
    discount: { type: String },
    paymentMethod: { type: String },
    status: { type: String },
    quantity: { type: String },
  },
  { _id: false }
);

const rowErrorSchema = new mongoose.Schema(
  {
    rowNumber: { type: Number },
    reason: { type: String, required: true },
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const uploadSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    r2Key: { type: String, required: true },
    fileFingerprint: {
      type: String,
      match: /^[a-f0-9]{64}$/,
    },
    posType: {
      type: String,
      enum: ['yoco', 'wizard'],
      required: true,
    },
    // How the column mapping was arrived at, for the owner's benefit. posType only
    // distinguishes yoco from everything else, so the history column read 'Mapped'
    // for a saved mapping, an AI guess and an abandoned upload alike.
    mappingSource: {
      type: String,
      enum: ['yoco', 'saved', 'ai', 'manual', 'none'],
    },
    columnMapping: { type: columnMappingSchema, default: {} },
    itemsMode: {
      type: String,
      enum: ['packed', 'line-per-row'],
      default: 'packed',
    },
    status: {
      type: String,
      enum: ['pending_mapping', 'parsing', 'completed', 'failed', 'deleted'],
      default: 'pending_mapping',
    },
    stats: {
      imported: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      totalRows: { type: Number, default: 0 },
      // Why rows were skipped, keyed by reason (e.g. status_not_approved: 2).
      // 'skipped' alone told an operator a number and nothing else.
      skippedByReason: { type: Object, default: {} },
    },
    // Sales this file carried that the cafe already held, and which uploads held them (BE-03-T03). 'skipped'
    // alone read as rows lost; this says they were already in and where from.
    overlap: {
      rows: { type: Number, default: 0, min: 0 },
      uploads: {
        type: [new mongoose.Schema({
          uploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload' },
          fileName: { type: String },
          rows: { type: Number, min: 0 },
        }, { _id: false })],
        default: [],
      },
    },
    dateRange: {
      firstDate: { type: Date },
      lastDate: { type: Date },
      firstDateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      lastDateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    },
    errorMessage: { type: String },
    rowErrors: { type: [rowErrorSchema], default: [] },
    headers: [{ type: String }],
    sampleRows: [{ type: mongoose.Schema.Types.Mixed }],
    completedAt: { type: Date },
    confirmation: {
      mappingHash: { type: String },
      idempotencyKeyHash: { type: String },
      replayCount: { type: Number, default: 0 },
    },
    maintenance: {
      status: {
        type: String,
        enum: ['not_started', 'queued', 'running', 'completed', 'partial_failure'],
        default: 'not_started',
      },
      attempts: { type: Number, default: 0, min: 0 },
      startedAt: { type: Date },
      completedAt: { type: Date },
      nextRetryAt: { type: Date },
      retryExhaustedAt: { type: Date },
      errors: [{ type: String }],
    },
    // Rows another upload held only through this one are re-admitted from this upload's own file when that other
    // upload is deleted or remapped (BE-03-T02). 'pending' means the maintenance queue still owes this upload that re-read.
    readmission: {
      status: { type: String, enum: ['pending', 'completed'] },
      firstDateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      lastDateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      sourceUploadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload' },
      requestedAt: { type: Date },
      completedAt: { type: Date },
      rows: { type: Number, min: 0 },
    },
  },
  { timestamps: true }
);

uploadSchema.index({ cafeId: 1, createdAt: -1 });
// Serves the overlap query of re-admission (BE-03-T02).
uploadSchema.index({ cafeId: 1, status: 1, 'dateRange.firstDate': 1 });
// The sweepers run hourly across every tenant; each reads only the few uploads it can act on (BE-03-T13). No query
// filters on fileFingerprint, so its two indexes went.
uploadSchema.index({ status: 1, updatedAt: 1 }); // pending_mapping expiry, stale parsing, failed expiry (BE-03-T12)
uploadSchema.index({ status: 1, errorMessage: 1, updatedAt: 1 }); // tombstones still owing storage cleanup; claimed parsing
uploadSchema.index({ 'maintenance.status': 1, updatedAt: 1 }, { partialFilterExpression: { status: 'completed' } });

module.exports = mongoose.model('Upload', uploadSchema);
