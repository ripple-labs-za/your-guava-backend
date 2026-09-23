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
      index: true,
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
      index: true,
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
      index: true,
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
uploadSchema.index({ cafeId: 1, fileFingerprint: 1, createdAt: -1 });
// Serves the overlap query of re-admission (BE-03-T02).
uploadSchema.index({ cafeId: 1, status: 1, 'dateRange.firstDate': 1 });

module.exports = mongoose.model('Upload', uploadSchema);
