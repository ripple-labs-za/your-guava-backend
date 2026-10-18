// Mongo reads that become model input: the business context and the thin-dataset check.
// Split by BE-11-T02; D-023 sales, refunds and gross basket definitions are shared with Performance.
const { saleCount, netRevenue, grossSales } = require('../analytics/semantics');
const Transaction = require('../../models/Transaction.model');
const Forecast = require('../../models/Forecast.model');
const Cafe = require('../../models/Cafe.model');
const Event = require('../../models/Event.model');
const Item = require('../../models/Item.model');
const Organization = require('../../models/Organization.model');
const { safeTimezone, addZonedDays, zonedDayStart, zonedDateKey } = require('../../utils/timezone');
const { roundMoney, zonedDateTimeLabel, dayNames, weekdayForKey, relativeDayLabel } = require('./prompts');
const { demandLines, DEMAND_LINE_MATCH } = require('../../utils/demand');
const { onApiCacheCleared } = require('../../middleware/cache.middleware');

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
  const today = zonedDayStart(new Date(), timezone);
  const since = addZonedDays(today, -14, timezone);
  const approved = await Transaction.countDocuments({
    cafeId,
    status: 'approved',
    date: { $gte: since, $lt: today },
  });
  return approved < MIN_INSIGHT_TRANSACTIONS;
};

const cafeAccessError = () => Object.assign(new Error('Cafe access is no longer available'), {
  statusCode: 403,
  code: 'CAFE_ACCESS_REVOKED',
  details: { code: 'CAFE_ACCESS_REVOKED' },
});

const CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTEXT_CACHE_MAX_ENTRIES = 200;
const contextCache = new Map();
let contextGeneration = 0;
let contextResetGeneration = 0;
const cafeGenerations = new Map();
const orgGenerations = new Map();
let contextBuilds = 0;
const contextCacheKey = ({ cafeId, orgId, authorizedCafeIds }) => JSON.stringify([
  String(orgId || ''), String(cafeId),
  Array.isArray(authorizedCafeIds) ? [...new Set(authorizedCafeIds.map(String))].sort() : null,
]);
const readCachedContext = (key) => {
  const entry = contextCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now() || entry.dayKey !== zonedDateKey(new Date(), entry.timezone)) {
    contextCache.delete(key);
    return null;
  }
  contextCache.delete(key);
  contextCache.set(key, entry);
  return entry.context;
};
const storeContext = (key, context, { cafeIds, orgId, timezone, dayKey }) => {
  contextCache.set(key, { context, cafeIds: new Set(cafeIds.map(String)), orgId: String(orgId || ''), timezone, dayKey,
    expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
  while (contextCache.size > CONTEXT_CACHE_MAX_ENTRIES) contextCache.delete(contextCache.keys().next().value);
};
/** D-005: one instance. Imports drop every organisation view containing this cafe. */
const invalidateBusinessContext = (cafeId) => {
  contextGeneration += 1;
  if (cafeId && contextBuilds) cafeGenerations.set(String(cafeId), contextGeneration);
  if (!cafeId) {
    contextResetGeneration = contextGeneration;
    cafeGenerations.clear();
    orgGenerations.clear();
  }
  for (const [key, entry] of contextCache) {
    if (!cafeId || entry.cafeIds.has(String(cafeId))) contextCache.delete(key);
  }
};
// A cafe edit evicts every view containing it; an org edit keeps other tenants warm.
onApiCacheCleared(({ cafeId, orgId }) => {
  if (cafeId) return invalidateBusinessContext(cafeId);
  contextGeneration += 1;
  if (contextBuilds) orgGenerations.set(String(orgId), contextGeneration);
  for (const [key, entry] of contextCache) {
    if (entry.orgId === String(orgId)) contextCache.delete(key);
  }
});
const _resetBusinessContextCache = () => invalidateBusinessContext();

const buildBusinessContext = async ({ cafeId, orgId, authorizedCafeIds }) => {
  const scopedCafeIds = Array.isArray(authorizedCafeIds)
    ? [...new Set(authorizedCafeIds.map(String))]
    : null;
  if (scopedCafeIds && !scopedCafeIds.includes(String(cafeId))) {
    throw cafeAccessError();
  }

  const key = contextCacheKey({ cafeId, orgId, authorizedCafeIds });
  const cached = readCachedContext(key);
  if (cached) return cached;
  const generation = contextGeneration;
  contextBuilds += 1;
  try {

  const [activeCafe, organization] = await Promise.all([
    Cafe.findOne({ _id: cafeId, archivedAt: null, ...(orgId ? { orgId } : {}) }).select('orgId name location timezone dataUploaded lastSyncAt').lean(),
    orgId ? Organization.findById(orgId).select('name plan').lean() : null,
  ]);

  if (!activeCafe) {
    throw cafeAccessError();
  }

  const cafes = orgId
    ? await Cafe.find({
        orgId,
        archivedAt: null,
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
  // Two indexed reads run together: item unwinding must not serialize the summary branches.
  const timezoneByCafe = { $switch: {
    branches: cafes.map((cafe) => ({ case: { $eq: ['$cafeId', cafe._id] }, then: safeTimezone(cafe.timezone) })),
    default: activeTimezone,
  } };
  const [facetRows, topItems, recentTransactions, menuItems, menuItemIssues, forecasts, upcomingEvents] = await Promise.all([
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      // Collapse identical summary dimensions once before the small facet groups;
      // no item arrays are carried through this read.
      { $group: {
        _id: { cafeId: '$cafeId', dayOfWeek: '$dayOfWeek', hour: '$hour', hourKnown: '$hourKnown',
          paymentMethod: { $ifNull: ['$paymentMethod', 'unknown'] }, timezone: timezoneByCafe,
          date: { $dateTrunc: { date: '$date', unit: 'day', timezone: timezoneByCafe } } },
        transactions: saleCount, revenue: netRevenue, grossSales,
        firstDate: { $min: '$date' }, lastDate: { $max: '$date' }, rows: { $sum: 1 },
      } },
      { $facet: {
        locationTotals: [
          {
            $group: {
              _id: '$_id.cafeId',
              transactions: { $sum: '$transactions' }, revenue: { $sum: '$revenue' },
              firstDate: { $min: '$firstDate' }, lastDate: { $max: '$lastDate' },
              grossSales: { $sum: '$grossSales' },
              hourUnknown: { $sum: { $cond: [{ $eq: ['$_id.hourKnown', false] }, '$rows', 0] } },
            },
          },
          { $sort: { revenue: -1 } },
        ],
        dayPattern: [
          {
            $group: {
              _id: '$_id.dayOfWeek',
              grossSales: { $sum: '$grossSales' }, revenue: { $sum: '$revenue' },
              transactions: { $sum: '$transactions' },
            },
          },
          { $sort: { _id: 1 } },
        ],
        hourPattern: [
          { $match: { '_id.cafeId': activeCafeId, '_id.hour': { $gte: 0, $lte: 23 }, '_id.hourKnown': { $ne: false } } },
          {
            $group: {
              _id: '$_id.hour',
              revenue: { $sum: '$revenue' }, transactions: { $sum: '$transactions' },
            },
          },
          { $sort: { _id: 1 } },
        ],
        paymentStats: [
          {
            $group: {
              _id: '$_id.paymentMethod',
              transactions: { $sum: '$transactions' }, revenue: { $sum: '$revenue' },
            },
          },
          { $sort: { transactions: -1 } },
          { $limit: 12 },
        ],
        dailyRevenue: [
          { $group: {
            _id: { cafeId: '$_id.cafeId', timezone: '$_id.timezone', date: '$_id.date' },
            revenue: { $sum: '$revenue' }, transactions: { $sum: '$transactions' },
          } },
          { $set: {
            '_id.date': { $dateToString: { format: '%Y-%m-%d', date: '$_id.date', timezone: '$_id.timezone' } },
            locationOrder: { $indexOfArray: [cafeIds, '$_id.cafeId'] },
          } },
          { $sort: { '_id.date': -1, locationOrder: 1 } },
          { $limit: 120 },
        ],
      } },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      { $project: { _id: 0,
        'items.name': 1, 'items.quantity': 1, 'items.unitPrice': 1, 'items.menuItemStatus': 1 } },
          { $unwind: '$items' },
          { $match: DEMAND_LINE_MATCH },
          { $group: {
            _id: '$items.name', quantity: { $sum: '$items.quantity' },
            revenue: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitPrice', 0] }] } },
          } },
          { $sort: { quantity: -1 } },
          { $limit: 25 },
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
      .select('date totalPredictedRevenue signals accuracy items.itemName items.predictedQty')
      .lean(),
    Event.find({ cafeId, date: { $gte: today, $lt: eventRangeEnd } })
      .sort({ date: 1 })
      .limit(20)
      .select('name date impact notes')
      .lean(),
  ]);

  const { locationTotals, dayPattern, hourPattern, paymentStats, dailyRevenue: newestDaily } = facetRows[0];
  const dailyRevenue = newestDaily.slice().reverse();
  const hourUnknownCount = locationTotals.find((row) => String(row._id) === String(activeCafeId))?.hourUnknown || 0;
  // The per-location groups already contain these totals; do not scan the same
  // rows again for an organisation-wide group or unknown-time count.
  const total = locationTotals.reduce((sum, row) => ({
    transactions: sum.transactions + row.transactions,
    revenue: sum.revenue + row.revenue,
    grossSales: sum.grossSales + row.grossSales,
    firstDate: !sum.firstDate || row.firstDate < sum.firstDate ? row.firstDate : sum.firstDate,
    lastDate: !sum.lastDate || row.lastDate > sum.lastDate ? row.lastDate : sum.lastDate,
  }), { transactions: 0, revenue: 0, grossSales: 0, firstDate: null, lastDate: null });

  const context = {
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
      avgBasket: roundMoney(total.transactions > 0 ? total.grossSales / total.transactions : 0),
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
      avgRevenuePerTransaction: row.transactions ? roundMoney(row.grossSales / row.transactions) : 0,
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
  // Never publish an old snapshot if an import or edit finished during the reads.
  const contextOrgId = String(orgId || activeCafe.orgId || '');
  if (generation >= contextResetGeneration && generation >= (orgGenerations.get(contextOrgId) || 0) &&
      cafeIds.every((id) => generation >= (cafeGenerations.get(String(id)) || 0))) {
    storeContext(key, context, { cafeIds, orgId: contextOrgId, timezone: activeTimezone, dayKey: todayKey });
  }
  return context;
  } finally {
    contextBuilds -= 1;
    // Version fences only protect in-flight reads, not cached entries. Do not
    // retain a forever-growing tenant/cafe registry after all reads settle.
    if (contextBuilds === 0) {
      cafeGenerations.clear();
      orgGenerations.clear();
    }
  }
};

module.exports = {
  cafeAccessError, MIN_INSIGHT_TRANSACTIONS, insightDatasetIsTooThin, buildBusinessContext, invalidateBusinessContext, _resetBusinessContextCache,
};
