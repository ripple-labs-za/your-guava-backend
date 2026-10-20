// GET /analytics/items.
// Split by BE-11-T04; D-023 defines sales, refunds and observed open-day averages.
const mongoose = require('mongoose');
const { aggregateOptions, isQueryTimeout, queryTimeoutError } = require('../../services/analytics/limits');
const Cafe = require('../../models/Cafe.model');
const { safeTimezone, zonedDayStart, zonedDayEnd, zonedDateKey } = require('../../utils/timezone');
const { getCafeTradingHours, hasSavedTradingHours } = require('../../utils/tradingHours');
const { rankMovers, itemTrend, MOVER_MIN_QTY_PER_WEEK } = require('../../services/analytics/movers');
const { saleCount } = require('../../services/analytics/semantics');
const { openDaysBetween, shiftDay, mongoRound, lastCompleteDay, trendWindows } = require('../../services/analytics/windows');
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

    // The presence per day (first and last day, open days) and the top items run at the same time (BE-14-T02). They used to run
    // one after the other because the items pipeline divided by the open-day count; avgPerDay is now computed after both, rounded
    // as $round does (mongoRound). Two concurrent scans, not one $facet: a facet runs its branches in turn in one thread, and on the
    // Perf Cafe it was no faster (365 days: 1,540 ms before, 1,559 ms as a facet).
    const [presence, topItems] = await Promise.all([
      Transaction.aggregate([
        { $match: matchStage },
        { $group: { _id: dateToString('%Y-%m-%d', timezone), transactions: saleCount } },
        { $sort: { _id: 1 } },
      ], aggregateOptions()),
      Transaction.aggregate([
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
        { $project: { _id: 0, name: '$_id', totalQty: 1, totalRevenue: { $round: ['$totalRevenue', 2] } } },
      ], aggregateOptions()),
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
    const items = topItems.map((item) => ({ ...item, avgPerDay: openDays > 0 ? mongoRound(item.totalQty / openDays, 1) : 0 }));

    // Totals keep today's sales; movers compare complete local days, just as the revenue trend does.
    // Historical windows retain their existing last-data-day anchor. Only the effective end is needed here:
    // whether there is enough earlier history for a revenue comparison does not change the completed day.
    const today = zonedDateKey(new Date(), timezone);
    const requestedEnd = zonedDateKey(dateMatch.$lte, timezone);
    let moverEnd = lastDay;
    if (requestedEnd >= today) {
      const completeEnd = lastCompleteDay({ endDate: requestedEnd, today });
      const lastCompleted = presence.filter((row) => row._id <= completeEnd).at(-1)?._id || null;
      moverEnd = trendWindows({
        startDate: zonedDateKey(dateMatch.$gte, timezone), endDate: requestedEnd, today,
        firstDataDate: null, lastDataDate: lastCompleted,
        tradingHours: hasSavedTradingHours(cafe) ? cafe.tradingHours : [],
      }).effective?.endDate || null;
    }
    const trendEnd = moverEnd ? zonedDayEnd(moverEnd, timezone) : null;
    const currentStart = moverEnd ? zonedDayStart(shiftDay(moverEnd, -6), timezone) : null;
    const previousStart = moverEnd ? zonedDayStart(shiftDay(moverEnd, -13), timezone) : null;


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

    const trendData = moverEnd ? await Transaction.aggregate(trendPipeline, aggregateOptions()) : [];

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
      return { ...item, trend: itemTrend(qty), isNew: qty.previous === 0 && qty.current >= MOVER_MIN_QTY_PER_WEEK };
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
    next(isQueryTimeout(error) ? queryTimeoutError() : error);
  }
};

module.exports = {
  getItems,
};
