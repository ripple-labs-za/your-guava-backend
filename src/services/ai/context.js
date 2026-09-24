// Mongo reads that become model input: the business context and the thin-dataset check.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const Transaction = require('../../models/Transaction.model');
const Forecast = require('../../models/Forecast.model');
const Cafe = require('../../models/Cafe.model');
const Event = require('../../models/Event.model');
const Item = require('../../models/Item.model');
const Organization = require('../../models/Organization.model');
const { safeTimezone, addZonedDays, zonedDayStart, zonedDateKey } = require('../../utils/timezone');
const { roundMoney, zonedDateTimeLabel, dayNames, weekdayForKey, relativeDayLabel } = require('./prompts');
const { demandLines, DEMAND_LINE_MATCH } = require('../../utils/demand');

// The bar for "there is something to analyse". Below it we decline before the
// provider call so nothing is billed: buildSummaryStats has nothing to report,
// and an insight generated from that sentence is filler dressed up as analysis.
const MENU_ITEM_CONTEXT_SELECT = 'cafeId name category avgPrice totalSold expectedPrice reviewStatus aliases priceMismatchCount lastPriceMismatchAt observedPriceMin observedPriceMax';

// One 12-field projection for both menu lists; the keys keep their order, so fencedJson(context) is unchanged.
const menuItemContext = (item, cafeNameById) => ({
  location: cafeNameById.get(item.cafeId.toString()) || item.cafeId,
  name: item.name,
  category: item.category,
  avgPrice: item.avgPrice,
  totalSold: item.totalSold,
  expectedPrice: item.expectedPrice,
  reviewStatus: item.reviewStatus,
  aliases: item.aliases || [],
  priceMismatchCount: item.priceMismatchCount || 0,
  lastPriceMismatchAt: item.lastPriceMismatchAt,
  observedPriceMin: item.observedPriceMin,
  observedPriceMax: item.observedPriceMax,
});

const MIN_INSIGHT_TRANSACTIONS = 1;

/**
 * True when the cafe has too little recent trade for an insight run to mean
 * anything. With no approved transactions buildSummaryStats returns a single
 * "no data" sentence, and the model is still asked to "be specific with
 * numbers" — so a brand-new cafe paid 10 Guava Credits for generic filler
 * presented as data-derived analysis. Forecasting already refuses in this
 * situation with an explicit insufficient-history state; insights did not.
 */
const insightDatasetIsTooThin = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  const timezone = safeTimezone(cafe?.timezone);
  const since = addZonedDays(zonedDayStart(new Date(), timezone), -14, timezone);
  const approved = await Transaction.countDocuments({
    cafeId,
    status: 'approved',
    date: { $gte: since },
  });
  return approved < MIN_INSIGHT_TRANSACTIONS;
};

const buildBusinessContext = async ({ cafeId, orgId, authorizedCafeIds }) => {
  const scopedCafeIds = Array.isArray(authorizedCafeIds)
    ? [...new Set(authorizedCafeIds.map(String))]
    : null;
  if (scopedCafeIds && !scopedCafeIds.includes(String(cafeId))) {
    const err = new Error('Cafe access is no longer available');
    err.statusCode = 403;
    throw err;
  }

  const [activeCafe, organization] = await Promise.all([
    Cafe.findOne({ _id: cafeId, ...(orgId ? { orgId } : {}) }).lean(),
    orgId ? Organization.findById(orgId).lean() : null,
  ]);

  if (!activeCafe) {
    const err = new Error('Cafe access is no longer available');
    err.statusCode = 403;
    throw err;
  }

  const cafes = orgId
    ? await Cafe.find({
        orgId,
        ...(scopedCafeIds ? { _id: { $in: scopedCafeIds } } : {}),
      }).select('name location timezone dataUploaded lastSyncAt yocoConnected createdAt').lean()
    : activeCafe ? [activeCafe] : [];

  const cafeIds = cafes.map((cafe) => cafe._id);
  const cafeNameById = new Map(cafes.map((cafe) => [cafe._id.toString(), cafe.name]));
  const activeCafeId = activeCafe?._id || cafeId;
  const activeTimezone = safeTimezone(activeCafe.timezone);

  const now = new Date();
  const today = zonedDayStart(now, activeTimezone);
  const todayKey = zonedDateKey(today, activeTimezone);
  const ninetyDaysAgo = addZonedDays(today, -90, activeTimezone);
  const forecastRangeEnd = addZonedDays(today, 7, activeTimezone);
  const eventRangeEnd = addZonedDays(today, 30, activeTimezone);

  const baseMatch = { cafeId: { $in: cafeIds }, status: 'approved' };
  const activeCafeMatch = { cafeId: activeCafeId, status: 'approved' };
  const dailyRevenuePromise = Promise.all(
    cafes.map((cafe) => {
      const timezone = safeTimezone(cafe.timezone);
      return Transaction.aggregate([
        {
          $match: {
            cafeId: cafe._id,
            status: 'approved',
            date: { $gte: ninetyDaysAgo },
          },
        },
        {
          $group: {
            _id: {
              cafeId: '$cafeId',
              date: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$date',
                  timezone,
                },
              },
            },
            revenue: { $sum: '$total' },
            transactions: { $sum: 1 },
          },
        },
      ]);
    })
  ).then((rows) =>
    rows
      .flat()
      .sort((a, b) => String(b._id.date).localeCompare(String(a._id.date)))
      .slice(0, 120)
      .reverse()
  );

  const [
    totals,
    locationTotals,
    dailyRevenue,
    topItems,
    dayPattern,
    hourPattern,
    paymentStats,
    recentTransactions,
    menuItems,
    menuItemIssues,
    forecasts,
    upcomingEvents,
    hourUnknownCount,
  ] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: null,
          transactions: { $sum: 1 },
          revenue: { $sum: '$total' },
          firstDate: { $min: '$date' },
          lastDate: { $max: '$date' },
          avgBasket: { $avg: '$total' },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: '$cafeId',
          transactions: { $sum: 1 },
          revenue: { $sum: '$total' },
        },
      },
      { $sort: { revenue: -1 } },
    ]),
    dailyRevenuePromise,
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      { $unwind: '$items' },
      { $match: DEMAND_LINE_MATCH },
      {
        $group: {
          _id: '$items.name',
          quantity: { $sum: '$items.quantity' },
          revenue: {
            $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitPrice', 0] }] },
          },
        },
      },
      { $sort: { quantity: -1 } },
      { $limit: 25 },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: '$dayOfWeek',
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...activeCafeMatch, date: { $gte: ninetyDaysAgo }, hour: { $gte: 0, $lte: 23 }, hourKnown: { $ne: false } } },
      {
        $group: {
          _id: '$hour',
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: { $ifNull: ['$paymentMethod', 'unknown'] },
          transactions: { $sum: 1 },
          revenue: { $sum: '$total' },
        },
      },
      { $sort: { transactions: -1 } },
      { $limit: 12 },
    ]),
    Transaction.find(activeCafeMatch)
      .sort({ date: -1 })
      .limit(25)
      .select('date hourKnown total items paymentMethod source')
      .lean(),
    Item.find({ cafeId: { $in: cafeIds }, isActive: true })
      .sort({ totalSold: -1 })
      .limit(30)
      .select(MENU_ITEM_CONTEXT_SELECT)
      .lean(),
    Item.find({
      cafeId: { $in: cafeIds },
      isActive: { $ne: false },
      $or: [
        { reviewStatus: 'needs_review' },
        { priceMismatchCount: { $gt: 0 } },
        { lastPriceMismatchAt: { $ne: null } },
      ],
    })
      .sort({ reviewStatus: -1, lastPriceMismatchAt: -1, totalSold: -1 })
      .limit(20)
      .select(MENU_ITEM_CONTEXT_SELECT)
      .lean(),
    Forecast.find({ cafeId, date: { $gte: today, $lt: forecastRangeEnd } })
      .sort({ date: 1 })
      .select('date items signals totalPredictedRevenue accuracy')
      .lean(),
    Event.find({ cafeId, date: { $gte: today, $lt: eventRangeEnd } })
      .sort({ date: 1 })
      .limit(20)
      .lean(),
    Transaction.countDocuments({ ...activeCafeMatch, date: { $gte: ninetyDaysAgo }, hourKnown: false }),
  ]);

  const total = totals[0] || {};

  return {
    organization: organization
      ? { name: organization.name, plan: organization.plan }
      : null,
    activeLocation: activeCafe
      ? {
          id: activeCafe._id,
          name: activeCafe.name,
          city: activeCafe.location?.city,
          timezone: activeTimezone,
          dataUploaded: activeCafe.dataUploaded,
          lastSyncAt: activeCafe.lastSyncAt,
        }
      : null,
    locations: cafes.map((cafe) => ({
      id: cafe._id,
      name: cafe.name,
      city: cafe.location?.city,
      timezone: safeTimezone(cafe.timezone),
      dataUploaded: cafe.dataUploaded,
      lastSyncAt: cafe.lastSyncAt,
    })),
    dataset: {
      transactionCount: total.transactions || 0,
      totalRevenue: roundMoney(total.revenue),
      avgBasket: roundMoney(total.avgBasket),
      firstDate: total.firstDate ? zonedDateTimeLabel(total.firstDate, activeTimezone) : null,
      lastDate: total.lastDate ? zonedDateTimeLabel(total.lastDate, activeTimezone) : null,
      contextWindow: 'Location, item, day, hour, and payment aggregates use the last 90 days. The daily series is capped to the newest 120 location-days. Recent transaction samples are capped at 25 rows and 40 items per row. Conversation history is capped to the last 10 messages, and each message is capped to its first 4000 characters — if a question was longer than that, say so rather than answering as if you had seen all of it.'
        + (hourUnknownCount > 0
          ? ` ${hourUnknownCount === 1 ? '1 sale in the last 90 days came from an export' : `${hourUnknownCount} sales in the last 90 days came from exports`} with dates but no times; the hour pattern leaves ${hourUnknownCount === 1 ? 'it' : 'them'} out, so do not describe ${hourUnknownCount === 1 ? 'its hour' : 'their hours'}.`
          : ''),
    },
    locationPerformance90d: locationTotals.map((row) => ({
      location: cafeNameById.get(row._id.toString()) || row._id,
      transactions: row.transactions,
      revenue: roundMoney(row.revenue),
    })),
    dailyRevenue90d: dailyRevenue.map((row) => ({
      location: cafeNameById.get(row._id.cafeId.toString()) || row._id.cafeId,
      date: row._id.date,
      revenue: roundMoney(row.revenue),
      transactions: row.transactions,
    })),
    topItems90d: topItems.map((item) => ({
      name: item._id,
      quantity: item.quantity,
      revenue: roundMoney(item.revenue),
    })),
    dayOfWeekPattern90d: dayPattern.map((row) => ({
      day: dayNames[row._id] || String(row._id),
      revenue: roundMoney(row.revenue),
      transactions: row.transactions,
      avgRevenuePerTransaction: row.transactions ? roundMoney(row.revenue / row.transactions) : 0,
    })),
    activeLocationHourPattern90d: hourPattern.map((row) => ({
      hour: row._id,
      revenue: roundMoney(row.revenue),
      transactions: row.transactions,
    })),
    // Sales from exports with dates but no times are not in the hour pattern. Saying how many stops the model reading
    // a thin pattern as the cafe's real trading hours.
    activeLocationHourCoverage90d: { transactionsWithoutTime: hourUnknownCount },
    paymentMethods90d: paymentStats.map((row) => ({
      method: row._id,
      transactions: row.transactions,
      revenue: roundMoney(row.revenue),
    })),
    menuItems: menuItems.map((item) => menuItemContext(item, cafeNameById)),
    menuItemIssues: menuItemIssues.map((item) => menuItemContext(item, cafeNameById)),
    // Relative-date questions -- "what should I prepare tomorrow", "how does this
    // weekend look" -- are the most common thing anyone asks. Without an explicit
    // anchor the model has to infer which forecast is which from bare date keys,
    // and defaults to the first entry, answering for today under a "tomorrow"
    // heading. State the current cafe-local day, and label each forecast relative
    // to it so the mapping is never a guess.
    currentDate: {
      date: todayKey,
      dayOfWeek: weekdayForKey(todayKey),
      timezone: activeTimezone,
    },
    upcomingForecasts: forecasts.map((forecast) => ({
      date: zonedDateKey(forecast.date, activeTimezone),
      dayOfWeek: weekdayForKey(zonedDateKey(forecast.date, activeTimezone)),
      relativeDay: relativeDayLabel(zonedDateKey(forecast.date, activeTimezone), todayKey),
      totalPredictedRevenue: forecast.totalPredictedRevenue,
      topItems: (forecast.items || [])
        .slice()
        .sort((a, b) => (b.predictedQty || 0) - (a.predictedQty || 0))
        .slice(0, 10)
        .map((item) => ({ itemName: item.itemName, predictedQty: item.predictedQty })),
      signals: forecast.signals,
      accuracy: forecast.accuracy,
    })),
    upcomingEvents: upcomingEvents.map((event) => ({
      name: event.name,
      date: zonedDateKey(event.date, activeTimezone),
      impact: event.impact,
      notes: event.notes,
    })),
    recentTransactions: recentTransactions.map((tx) => ({
      // A sale from a date-only export has no time: label it with its day, not a made-up midnight.
      localDateTime: tx.hourKnown === false ? zonedDateKey(tx.date, activeTimezone) : zonedDateTimeLabel(tx.date, activeTimezone),
      timeKnown: tx.hourKnown !== false,
      timezone: activeTimezone,
      total: tx.total,
      paymentMethod: tx.paymentMethod,
      source: tx.source,
      items: demandLines(tx.items).slice(0, 40).map((item) => ({
        name: String(item.name || '').slice(0, 200),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    })),
  };
};

module.exports = {
  MIN_INSIGHT_TRANSACTIONS, insightDatasetIsTooThin, buildBusinessContext,
};
