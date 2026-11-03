const mongoose = require('mongoose');

// One record per scheduled unit of work (L-2: `nightly:<cafeId>:<dateKey>`). The unique key is the lock: a second
// claim of the same key fails on the index, so a unit runs once even if two processes ever race. A failed or
// abandoned (stale running) unit may be claimed again; a done unit never is.
const jobRunSchema = new mongoose.Schema({
  key: { type: String, required: true, maxlength: 200 },
  status: { type: String, enum: ['running', 'done', 'failed'], required: true },
  attempts: { type: Number, default: 0 },
  startedAt: { type: Date },
  finishedAt: { type: Date },
  // A failed unit is not claimed again before this (backoff between retries).
  retryAfter: { type: Date },
  summary: { type: mongoose.Schema.Types.Mixed },
  error: { type: String, maxlength: 500 },
}, { timestamps: true });

jobRunSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('JobRun', jobRunSchema);
