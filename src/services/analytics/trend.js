const { aggregateOptions } = require('./limits');
const Transaction = require('../../models/Transaction.model');
const Cafe = require('../../models/Cafe.model');
const { hasSavedTradingHours } = require('../../utils/tradingHours');
const { zonedDateKey, zonedDayStart, zonedDayEnd } = require('../../utils/timezone');
const { trendWindows, lastCompleteDay } = require('./windows');

const round2 = (value) => parseFloat(value.toFixed(2));

const windowStart = (day, timezone, minimum) => new Date(Math.max(zonedDayStart(day, timezone).getTime(), minimum?.getTime() ?? -Infinity));

const approvedRevenueBetween = async (cafeObjectId, fromDay, toDay, timezone, minimum) => {
  const [row] = await Transaction.aggregate([
    {
      $match: {
        cafeId: cafeObjectId,
        status: 'approved',
          date: { $gte: windowStart(fromDay, timezone, minimum), $lte: zonedDayEnd(toDay, timezone) },
      },
    },
    { $group: { _id: null, revenue: { $sum: '$total' } } },
  ], aggregateOptions());
  return row ? row.revenue : 0;
};

const describeWindow = (window, revenue, timezone, minimum) => window && {
  ...window,
  start: windowStart(window.startDate, timezone, minimum).toISOString(),
  end: zonedDayEnd(window.endDate, timezone).toISOString(),
  revenue: revenue == null ? null : round2(revenue),
};

/**
 * Revenue trend over two equal, complete, data-backed spans (analytics-ai-2). Returns trend null with a reason whenever an
 * honest comparison is impossible, instead of a 0 that reads as "flat" or a negative that reads as "shrinking".
 */
const revenueTrend = async ({ cafeObjectId, startDate, endDate, timezone, now = new Date() }) => {
  const startDay = zonedDateKey(startDate, timezone);
  const endDay = zonedDateKey(endDate, timezone);
  const today = zonedDateKey(now, timezone);
  const completeEnd = lastCompleteDay({ endDate: endDay, today });
  const cafe = await Cafe.findById(cafeObjectId).select('tradingHours').lean();

  let firstRow = null;
  let lastRow = null;
  if (completeEnd >= startDay) {
    [lastRow, firstRow] = await Promise.all([
      Transaction.findOne({
        cafeId: cafeObjectId,
        status: 'approved',
        date: { $gte: startDate, $lte: zonedDayEnd(completeEnd, timezone) },
      }).sort({ date: -1 }).select('date').maxTimeMS(aggregateOptions().maxTimeMS).lean(),
      Transaction.findOne({ cafeId: cafeObjectId, status: 'approved' }).sort({ date: 1 }).select('date').maxTimeMS(aggregateOptions().maxTimeMS).lean(),
    ]);
  }

  const windows = trendWindows({
    startDate: startDay,
    endDate: endDay,
    today,
    firstDataDate: firstRow ? zonedDateKey(firstRow.date, timezone) : null,
    lastDataDate: lastRow ? zonedDateKey(lastRow.date, timezone) : null,
    tradingHours: hasSavedTradingHours(cafe) ? cafe.tradingHours : [],
  });

  let trend = null;
  let reason = windows.reason;
  let currentRevenue = null;
  let previousRevenue = null;
  if (windows.comparable) {
    [currentRevenue, previousRevenue] = await Promise.all([
      approvedRevenueBetween(cafeObjectId, windows.effective.startDate, windows.effective.endDate, timezone, startDate),
      approvedRevenueBetween(cafeObjectId, windows.comparison.startDate, windows.comparison.endDate, timezone),
    ]);
    if (previousRevenue > 0) {
      // Normalize rounded -0 for callers; JSON already serializes either zero as 0.
      trend = parseFloat((((currentRevenue - previousRevenue) / previousRevenue) * 100).toFixed(1)) || 0;
    } else {
      reason = 'no_previous_revenue';
    }
  }

  return {
    trend,
    reason,
    effectiveWindow: describeWindow(windows.effective, currentRevenue, timezone, startDate),
    comparisonWindow: describeWindow(windows.comparison, previousRevenue, timezone),
  };
};

module.exports = { revenueTrend };
