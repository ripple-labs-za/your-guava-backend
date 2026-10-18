// GET /analytics/revenue.
// Split by BE-11-T04; summaries and complete-span trends corrected by BE-04.
const mongoose = require('mongoose');
const { aggregateOptions, isQueryTimeout, queryTimeoutError } = require('../../services/analytics/limits');
const Cafe = require('../../models/Cafe.model');
const { safeTimezone } = require('../../utils/timezone');
const { getCafeTradingHours } = require('../../utils/tradingHours');
const { saleCount, netRevenue } = require('../../services/analytics/semantics');
const { dailySummary } = require('../../services/analytics/windows');
const { revenueTrend } = require('../../services/analytics/trend');
const Transaction = require('../../models/Transaction.model');
const {
  buildDateMatch, dateToString, analyticsRangeMeta,
} = require('./range');
const { activeCafeId } = require('../../utils/tenancy');

/**
 * GET /api/analytics/revenue
 * Revenue analytics grouped by period (daily/weekly/monthly)
 */
const getRevenue = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);
    const cafe = await Cafe.findById(cafeId).select('timezone tradingHours').lean();
    const timezone = safeTimezone(cafe?.timezone);
    const { period = 'daily' } = req.query;
    const dateMatch = buildDateMatch(req.query, timezone);
    const startDate = dateMatch.$gte;
    const endDate = dateMatch.$lte;
    const match = { cafeId: cafeObjectId, status: 'approved', date: { $gte: startDate, $lte: endDate } };
    const buckets = (format) => Transaction.aggregate([
      { $match: match },
      { $group: { _id: dateToString(format, timezone), revenue: netRevenue, transactions: saleCount } },
      { $sort: { _id: 1 } },
    ], aggregateOptions());

    const daily = await buckets('%Y-%m-%d');
    let periodRows = daily;
    if (period === 'weekly') periodRows = await buckets('%G-W%V');
    else if (period === 'monthly') periodRows = await buckets('%Y-%m');
    const data = periodRows.map((row) => ({
      date: row._id,
      revenue: parseFloat(row.revenue.toFixed(2)),
      transactions: row.transactions,
    }));

    // Summed before rounding, and per day regardless of period: weekly buckets are not days (analytics-ai-21).
    const totalRevenue = daily.reduce((sum, row) => sum + row.revenue, 0);
    const { openDays, bestDay, worstDay } = dailySummary({ daily, tradingHours: getCafeTradingHours(cafe) });

    const { trend, reason: trendReason, effectiveWindow, comparisonWindow } = await revenueTrend({
      cafeObjectId,
      startDate,
      endDate,
      timezone,
    });

    const summary = {
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      avgDailyRevenue: openDays > 0 ? parseFloat((totalRevenue / openDays).toFixed(2)) : 0,
      openDays,
      bestDay,
      worstDay,
      trend,
    };


    return res.status(200).json({
      success: true,
      data,
      summary,
      meta: {
        ...analyticsRangeMeta(req.query, dateMatch, timezone),
        summary,
        period,
        effectiveWindow,
        comparisonWindow,
        trendReason,
      },
    });
  } catch (error) {
    next(isQueryTimeout(error) ? queryTimeoutError() : error);
  }
};

module.exports = {
  getRevenue,
};
