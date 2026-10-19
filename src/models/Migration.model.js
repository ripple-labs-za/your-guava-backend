const mongoose = require('mongoose');

const runSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['applied', 'failed'], required: true },
    by: { type: String, maxlength: 40 },
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    stats: mongoose.Schema.Types.Mixed,
    error: { type: String, maxlength: 500 },
  },
  { _id: false }
);

// One document per migration, keyed by its name. `runs` keeps the last 20
// executions so an operator can see what ran on this database, when, and how.
const migrationSchema = new mongoose.Schema(
  {
    _id: { type: String },
    status: { type: String, enum: ['running', 'applied', 'failed'], required: true },
    kind: { type: String, enum: ['expand', 'data', 'contract'] },
    mode: { type: String, enum: ['auto', 'manual'] },
    attempts: { type: Number, default: 0 },
    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    lockedUntil: Date,
    lockedBy: { type: String, maxlength: 40 },
    stats: mongoose.Schema.Types.Mixed,
    lastError: { type: String, maxlength: 500 },
    runs: { type: [runSchema], default: [] },
  },
  { collection: 'migrations', timestamps: true, versionKey: false }
);

module.exports = mongoose.model('Migration', migrationSchema);
