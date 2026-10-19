const logger = require('../utils/logger');
const mongoose = require('mongoose');
const Upload = require('../models/Upload.model');
const Cafe = require('../models/Cafe.model');
const Transaction = require('../models/Transaction.model');
const { safeTimezone } = require('../utils/timezone');

/**
 * BE-03-T06. Rows imported before hourKnown existed from a file with no Time column sit at exactly 00:00:00 cafe time
 * with hour 0. They are marked hourKnown:false, hour:null so hour-of-day views stop reading them as midnight trade. A
 * real sale at exactly midnight in such a file is marked too; for a cafe that is vanishingly rare and the day is still
 * counted.
 *
 *   node src/migrations/mark-date-only-hours.js          # report only
 *   node src/migrations/mark-date-only-hours.js --apply  # make the change
 */
const markDateOnlyHours = async ({ apply = false } = {}) => {
  const uploads = await Upload.find({
    status: 'completed',
    $or: [{ 'columnMapping.time': { $exists: false } }, { 'columnMapping.time': null }, { 'columnMapping.time': '' }],
  }).select('_id cafeId').lean();
  const byCafe = new Map();
  for (const upload of uploads) {
    const key = String(upload.cafeId);
    byCafe.set(key, [...(byCafe.get(key) || []), upload._id]);
  }
  let matched = 0;
  let marked = 0;
  for (const [cafeId, uploadIds] of byCafe) {
    const cafe = await Cafe.findById(cafeId).select('timezone').lean();
    const timezone = safeTimezone(cafe?.timezone);
    const filter = {
      cafeId: new mongoose.Types.ObjectId(cafeId),
      uploadId: { $in: uploadIds },
      hourKnown: { $ne: false },
      $expr: {
        $and: ['$hour', '$minute', '$second'].map((unit) => ({
          $eq: [{ [unit]: { date: '$date', timezone } }, 0],
        })),
      },
    };
    matched += await Transaction.countDocuments(filter);
    if (apply) marked += (await Transaction.updateMany(filter, { $set: { hourKnown: false, hour: null } })).modifiedCount;
  }
  return { uploads: uploads.length, matched, marked };
};

if (require.main === module) {
  require('dotenv').config();
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const summary = await markDateOnlyHours({ apply: process.argv.includes('--apply') });
    logger.printLine(JSON.stringify(summary));
    await mongoose.disconnect();
  })().catch((error) => {
    logger.fatal('migration_cli_failed', logger.errorFields(error, { stack: true }));
    process.exit(1);
  });
}

module.exports = { markDateOnlyHours, up: () => markDateOnlyHours({ apply: true }) };
