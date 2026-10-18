require('dotenv').config();
const mongoose = require('mongoose');
const Cafe = require('../models/Cafe.model');
const Forecast = require('../models/Forecast.model');
const { updateForecastActuals } = require('../services/forecast.service');
const { addZonedDays, safeTimezone, zonedDayStart } = require('../utils/timezone');

/**
 * Re-scores stored scored forecasts so every day gains itemAccuracy (BE-06-T02). Idempotent: scoring a day twice gives the same numbers.
 *   node src/migrations/rescore-forecast-accuracy.js           # report only
 *   node src/migrations/rescore-forecast-accuracy.js --apply   # write
 */
const rescoreForecastAccuracy = async ({ apply = false, sinceDays = 366 } = {}) => {
  const cafes = await Cafe.find({}).select('_id timezone').lean();
  let scanned = 0;
  let rescored = 0;
  for (const cafe of cafes) {
    const timezone = safeTimezone(cafe.timezone);
    const today = zonedDayStart(new Date(), timezone);
    const days = await Forecast.find({
      cafeId: cafe._id,
      date: { $gte: addZonedDays(today, -sinceDays, timezone), $lt: today },
      actualsUpdatedAt: { $exists: true, $ne: null },
    }).select('date').sort({ date: 1 }).lean();
    scanned += days.length;
    if (!apply) continue;
    for (const day of days) {
      await updateForecastActuals(cafe._id, day.date, { timezone });
      rescored += 1;
    }
  }
  return { cafes: cafes.length, scanned, rescored };
};

if (require.main === module) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => rescoreForecastAccuracy({ apply: process.argv.includes('--apply') }))
    .then((stats) => { console.log(JSON.stringify(stats)); return mongoose.disconnect(); })
    .catch((error) => { console.error(error); process.exit(1); });
}

module.exports = { name: 'rescore-forecast-accuracy', rescoreForecastAccuracy };
