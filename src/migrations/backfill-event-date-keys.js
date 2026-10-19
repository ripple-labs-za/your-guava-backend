const logger = require('../utils/logger');
const mongoose = require('mongoose');
const Cafe = require('../models/Cafe.model');
const Event = require('../models/Event.model');
const { safeTimezone, storedDayKey } = require('../utils/timezone');

// Default report-only; cafeId optionally confines a local verification to its scratch cafe.
// Rollback: clearing dateKey leaves original dates readable but stops annual
// recurrence until keys are restored by running this migration again.
const backfillEventDateKeys = async ({ apply = false, cafeId } = {}) => {
  const events = await Event.find({ dateKey: { $exists: false }, ...(cafeId ? { cafeId } : {}) }).select('_id cafeId date').lean();
  const cafeIds = [...new Set(events.map((event) => String(event.cafeId)))];
  const cafes = await Cafe.find({ _id: { $in: cafeIds } }).select('_id timezone').lean();
  const zones = new Map(cafes.map((cafe) => [String(cafe._id), safeTimezone(cafe.timezone)]));
  const updates = events.map((event) => ({ id: event._id,
    dateKey: storedDayKey(event.date, zones.get(String(event.cafeId)) || safeTimezone()),
  })).filter((update) => update.dateKey);
  let updated = 0;
  if (apply && updates.length > 0) {
    const result = await Event.bulkWrite(updates.map((update) => ({ updateOne: {
      filter: { _id: update.id, dateKey: { $exists: false } }, update: { $set: { dateKey: update.dateKey } },
    } })));
    updated = result.modifiedCount;
  }
  return { scanned: events.length, updated, wouldUpdate: updates.length };
};

if (require.main === module) {
  require('dotenv').config();
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => backfillEventDateKeys({ apply: process.argv.includes('--apply') }))
    .then((stats) => { logger.printLine(JSON.stringify(stats)); return mongoose.disconnect(); })
    .catch((error) => { logger.fatal('migration_cli_failed', logger.errorFields(error, { stack: true })); process.exit(1); });
}

module.exports = { name: 'backfill-event-date-keys', backfillEventDateKeys };
