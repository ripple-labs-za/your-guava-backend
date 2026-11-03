// L-4 (#117): accuracy by week, so the owner can see the model improving. One definition of a scored day, the same as
// /forecasts/accuracy's headline: accuracy and actuals present, and not a day that was still building history.
const Forecast = require('../../models/Forecast.model');
const { addZonedDays, zonedDateKey, zonedDayOfWeek, zonedDayStart } = require('../../utils/timezone');

const WEEKLY_ACCURACY_WEEKS = 12;
// A week reads as live once it has this many live days; otherwise its backtested days stand in, as the headline does.
const WEEK_LIVE_MIN_DAYS = 3;

const mondayOf = (date, timezone) => {
  const day = zonedDayStart(date, timezone);
  return addZonedDays(day, -((zonedDayOfWeek(day, timezone) + 6) % 7), timezone);
};

const mean = (values) => (values.length ? Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(1)) : null);

/**
 * The last `weeks` cafe-local weeks (Monday start), oldest first, ending with the current week (completed days only).
 * Each: { weekStart, days, avgAccuracy, avgItemAccuracy, basis: 'live'|'backtest'|'none', modelVersions }.
 */
const weeklyAccuracy = async (cafeId, timezone, { weeks = WEEKLY_ACCURACY_WEEKS, now = new Date() } = {}) => {
  const today = zonedDayStart(now, timezone);
  const firstMonday = addZonedDays(mondayOf(today, timezone), -7 * (weeks - 1), timezone);
  const docs = await Forecast.find({
    cafeId,
    date: { $gte: firstMonday, $lt: today },
    accuracy: { $exists: true, $ne: null },
    actualsUpdatedAt: { $exists: true, $ne: null },
    'availability.status': { $ne: 'insufficient_data' },
  }).select('date origin modelVersion accuracy itemAccuracy').lean();

  const byWeek = new Map();
  for (const doc of docs) {
    const weekStart = zonedDateKey(mondayOf(doc.date, timezone), timezone);
    if (!byWeek.has(weekStart)) byWeek.set(weekStart, []);
    byWeek.get(weekStart).push(doc);
  }

  return Array.from({ length: weeks }, (_, index) => {
    const weekStart = zonedDateKey(addZonedDays(firstMonday, 7 * index, timezone), timezone);
    const days = byWeek.get(weekStart) || [];
    const live = days.filter((doc) => doc.origin !== 'backfill');
    const backtest = days.filter((doc) => doc.origin === 'backfill');
    const basis = live.length >= WEEK_LIVE_MIN_DAYS ? 'live' : backtest.length > 0 ? 'backtest' : live.length > 0 ? 'live' : 'none';
    const chosen = basis === 'live' ? live : basis === 'backtest' ? backtest : [];
    return {
      weekStart,
      days: chosen.length,
      avgAccuracy: mean(chosen.map((doc) => doc.accuracy)),
      avgItemAccuracy: mean(chosen.map((doc) => doc.itemAccuracy).filter(Number.isFinite)),
      basis,
      modelVersions: [...new Set(chosen.map((doc) => doc.modelVersion).filter(Boolean))],
    };
  });
};

module.exports = { weeklyAccuracy, WEEKLY_ACCURACY_WEEKS, WEEK_LIVE_MIN_DAYS };
