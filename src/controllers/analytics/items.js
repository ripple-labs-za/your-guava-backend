// GET /analytics/items.
// Split by BE-11-T04; D-023 defines sales, refunds and observed open-day averages.
const mongoose = require('mongoose');
const Cafe = require('../../models/Cafe.model');
const { safeTimezone, zonedDayStart, zonedDayEnd } = require('../../utils/timezone');
const { getCafeTradingHours } = require('../../utils/tradingHours');
const { rankMovers, itemTrend } = require('../../services/analytics/movers');
const { saleCount } = require('../../services/analytics/semantics');
const { openDaysBetween, shiftDay } = require('../../services/analytics/windows');
const Transaction = require('../../models/Transaction.model');
const { buildDateMatch, analyticsRangeMeta, dateToString } = require('./range');
const { activeCafeId } = require('../../utils/tenancy');
const { DEMAND_LINE_MATCH } = require('../../utils/demand');

/**
 * GET /api/analytics/items
 * Item performance with trends
 */
const getItems = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);
    const cafe = await Cafe.findById(cafeId).select('timezone tradingHours').lean();
    const timezone = safeTimezone(cafe?.timezone);

    const dateMatch = buildDateMatch(req.query, timezone);
    const matchStage = {
      cafeId: cafeObjectId,
      status: 'approved',
      date: dateMatch,
    };

    const presence = await Transaction.aggregate([
      { $match: matchStage },
      { $group: { _id: dateToString('%Y-%m-%d', timezone), transactions: saleCount } },
      { $sort: { _id: 1 } },
    ]);
    if (presence.length === 0) {
      return res.status(200).json({
        success: true, items: [], data: [], risingItems: [], decliningItems: [],
        meta: { ...analyticsRangeMeta(req.query, dateMatch, timezone), risingItems: [], decliningItems: [], newItems: [], moverFloor: rankMovers(new Map()).moverFloor },
      });
    }
    const firstDay = presence[0]._id;
    const lastDay = presence[presence.length - 1]._id;
    const openDays = openDaysBetween({
      fromDate: firstDay,
      toDate: lastDay,
      tradingHours: getCafeTradingHours(cafe),
      saleDays: new Set(presence.filter((day) => day.transactions > 0).map((day) => day._id)),
    }).length;

    // Top 20 items overall
    const itemsPipeline = [
      { $match: matchStage },
      { $unwind: '$items' },
      { $match: DEMAND_LINE_MATCH },
      {
        $group: {
          _id: '$items.name',
          totalQty: { $sum: '$items.quantity' },
          totalRevenue: {
            $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitPrice', 0] }] },
          },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          name: '$_id',
          totalQty: 1,
          totalRevenue: { $round: ['$totalRevenue', 2] },
          avgPerDay: openDays > 0 ? { $round: [{ $divide: ['$totalQty', openDays] }, 1] } : { $literal: 0 },
        },
      },
    ];

    const items = await Transaction.aggregate(itemsPipeline);

    // Trend: latest 7 local trading days in the selected data vs previous 7 days.
    const trendEnd = zonedDayEnd(lastDay, timezone);
    const currentStart = zonedDayStart(shiftDay(lastDay, -6), timezone);
    const previousStart = zonedDayStart(shiftDay(lastDay, -13), timezone);


    const trendPipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: previousStart, $lte: trendEnd },
        },
      },
      { $unwind: '$items' },
      { $match: DEMAND_LINE_MATCH },
      {
        $group: {
          _id: {
            name: '$items.name',
            period: {
              $cond: [{ $gte: ['$date', currentStart] }, 'current', 'previous'],
            },
          },
          totalQty: { $sum: '$items.quantity' },
        },
      },
    ];

    const trendData = await Transaction.aggregate(trendPipeline);

    // Build trend lookup: itemName -> { current, previous }. A Map, because
    // item names come from POS files: on a plain object, trendMap['__proto__']
    // returned Object.prototype and this loop wrote current/previous onto every
    // object in the process, for every cafe, until restart.
    const trendMap = new Map();
    for (const entry of trendData) {
      const name = entry._id.name;
      const period = entry._id.period;
      if (!trendMap.has(name)) trendMap.set(name, { current: 0, previous: 0 });
      trendMap.get(name)[period] = entry.totalQty;
    }

    const itemsWithTrend = items.map((item) => {
      const qty = trendMap.get(item.name) || { current: 0, previous: 0 };
      return { ...item, trend: itemTrend(qty), isNew: qty.previous === 0 && qty.current > 0 };
    });
    const { risingItems, decliningItems, newItems, moverFloor } = rankMovers(trendMap);

    return res.status(200).json({
      success: true,
      items: itemsWithTrend,
      data: itemsWithTrend,
      meta: {
        ...analyticsRangeMeta(req.query, dateMatch, timezone),
        observedSpan: { startDate: firstDay, endDate: lastDay, openDays },
        risingItems,
        decliningItems,
        newItems,
        moverFloor,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getItems,
};
