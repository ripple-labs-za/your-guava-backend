const Transaction = require('../../models/Transaction.model');
const { zonedDateKey, zonedDayStart, zonedDayEnd } = require('../../utils/timezone');
const { trendWindows, lastCompleteDay } = require('./windows');

const round2 = (value) => parseFloat(value.toFixed(2));

const approvedRevenueBetween = async (cafeObjectId, fromDay, toDay, timezone) => {
  const [row] = await Transaction.aggregate([
    {
      $match: {
        cafeId: cafeObjectId,
        status: 'approved',
        date: { $gte: zonedDayStart(fromDay, timezone), $lte: zonedDayEnd(toDay, timezone) },
      },
    },
    { $group: { _id: null, revenue: { $sum: '$total' } } },
  ]);
  return row ? row.revenue : 0;
};

const describeWindow = (window, revenue, timezone) => window && {
  ...window,
  start: zonedDayStart(window.startDate, timezone).toISOString(),
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

  let firstRow = null;
  let lastRow = null;
  if (completeEnd >= startDay) {
    [lastRow, firstRow] = await Promise.all([
      Transaction.findOne({
        cafeId: cafeObjectId,
        status: 'approved',
        date: { $gte: startDate, $lte: zonedDayEnd(completeEnd, timezone) },
      }).sort({ date: -1 }).select('date').lean(),
      Transaction.findOne({ cafeId: cafeObjectId, status: 'approved' }).sort({ date: 1 }).select('date').lean(),
    ]);
  }

  const windows = trendWindows({
    startDate: startDay,
    endDate: endDay,
    today,
    firstDataDate: firstRow ? zonedDateKey(firstRow.date, timezone) : null,
    lastDataDate: lastRow ? zonedDateKey(lastRow.date, timezone) : null,
  });

  let trend = null;
  let reason = windows.reason;
  let currentRevenue = null;
  let previousRevenue = null;
  if (windows.comparable) {
    [currentRevenue, previousRevenue] = await Promise.all([
      approvedRevenueBetween(cafeObjectId, windows.effective.startDate, windows.effective.endDate, timezone),
      approvedRevenueBetween(cafeObjectId, windows.comparison.startDate, windows.comparison.endDate, timezone),
    ]);
    if (previousRevenue > 0) {
      // `|| 0` turns a rounded -0 into 0, which JSON and Jest's toBe(0) both treat differently from -0.
      trend = parseFloat((((currentRevenue - previousRevenue) / previousRevenue) * 100).toFixed(1)) || 0;
    } else {
      reason = 'no_previous_revenue';
    }
  }

  return {
    trend,
    reason,
    effectiveWindow: describeWindow(windows.effective, currentRevenue, timezone),
    comparisonWindow: describeWindow(windows.comparison, previousRevenue, timezone),
  };
};

module.exports = { revenueTrend };
