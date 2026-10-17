// GET /analytics/heatmap.
// Moved from analytics.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const Transaction = require('../../models/Transaction.model');
const Cafe = require('../../models/Cafe.model');
const { isWeekdayHourOpen } = require('../../utils/tradingHours');
const { safeTimezone, buildDateMatch, dateToString, analyticsRangeMeta } = require('./range');
const { activeCafeId } = require('../../utils/tenancy');

/**
 * GET /api/analytics/heatmap
 * Peak hour heatmap — 7 days × 17 hours (6-22)
 */
const getHeatmap = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);
    const cafe = await Cafe.findById(cafeId).select('timezone tradingHours').lean();
    const timezone = safeTimezone(cafe?.timezone);

    const dateMatch = buildDateMatch(req.query, timezone);
    const windowMatch = {
      cafeId: cafeObjectId,
      status: 'approved',
      dayOfWeek: { $gte: 0, $lte: 6 },
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };
    // Sales from exports with dates but no times (BE-03-T06) have no hour: they fill no cell, and counting their days as
    // observed drew an all-zero grid that read "no trade in any hour". Rows stored before hourKnown existed stay in.
    const baseMatchStage = { ...windowMatch, hourKnown: { $ne: false } };
    const coveragePipeline = [
      { $match: windowMatch },
      { $group: { _id: { $eq: ['$hourKnown', false] }, count: { $sum: 1 } } },
    ];
    const heatmapMatchStage = {
      ...baseMatchStage,
      hour: { $gte: 6, $lte: 22 },
    };

    const dayCountPipeline = [
      { $match: baseMatchStage },
      {
        $group: {
          _id: {
            dayOfWeek: '$dayOfWeek',
            date: dateToString('%Y-%m-%d', timezone),
          },
        },
      },
      {
        $group: {
          _id: '$_id.dayOfWeek',
          observedDays: { $sum: 1 },
        },
      },
    ];

    const hourlyTotalsPipeline = [
      { $match: heatmapMatchStage },
      {
        $group: {
          _id: {
            dayOfWeek: '$dayOfWeek',
            hour: '$hour',
          },
          totalRevenue: { $sum: '$total' },
          totalTransactions: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          dayOfWeek: '$_id.dayOfWeek',
          hour: '$_id.hour',
          totalRevenue: { $round: ['$totalRevenue', 2] },
          totalTransactions: 1,
        },
      },
      { $sort: { dayOfWeek: 1, hour: 1 } },
    ];

    const [dayCounts, rawData, coverage] = await Promise.all([
      Transaction.aggregate(dayCountPipeline),
      Transaction.aggregate(hourlyTotalsPipeline),
      Transaction.aggregate(coveragePipeline),
    ]);
    const transactionsWithoutTime = coverage.find((entry) => entry._id === true)?.count || 0;
    const transactionsWithTime = coverage.find((entry) => entry._id === false)?.count || 0;
    const observedDaysByWeekday = new Map(
      dayCounts.map((entry) => [entry._id, entry.observedDays])
    );

    // Fill in the complete 7x17 grid with zeros for missing slots
    const dataMap = {};
    for (const entry of rawData) {
      const observedDays = observedDaysByWeekday.get(entry.dayOfWeek) || 1;
      dataMap[`${entry.dayOfWeek}-${entry.hour}`] = {
        dayOfWeek: entry.dayOfWeek,
        hour: entry.hour,
        revenue: parseFloat((entry.totalRevenue / observedDays).toFixed(2)),
        transactions: parseFloat((entry.totalTransactions / observedDays).toFixed(1)),
        totalRevenue: entry.totalRevenue,
        totalTransactions: entry.totalTransactions,
        observedDays,
        isOpen: isWeekdayHourOpen(entry.dayOfWeek, entry.hour, cafe),
      };
    }

    const heatmap = [];
    for (let day = 0; day <= 6; day++) {
      for (let hour = 6; hour <= 22; hour++) {
        const key = `${day}-${hour}`;
        if (dataMap[key]) {
          heatmap.push(dataMap[key]);
        } else {
          heatmap.push({
            dayOfWeek: day,
            hour,
            revenue: 0,
            transactions: 0,
            totalRevenue: 0,
            totalTransactions: 0,
            observedDays: observedDaysByWeekday.get(day) || 0,
            isOpen: isWeekdayHourOpen(day, hour, cafe),
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      heatmap,
      data: heatmap,
      meta: {
        ...analyticsRangeMeta(req.query, dateMatch, timezone),
        metric: 'average_per_observed_weekday',
        timeOfDay: { transactionsWithTime, transactionsWithoutTime },
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getHeatmap,
};
