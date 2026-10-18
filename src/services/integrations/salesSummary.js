const mongoose = require('mongoose');
const Transaction = require('../../models/Transaction.model');
const { safeTimezone, zonedDayStart, addZonedDays } = require('../../utils/timezone');
const { isDemandLine } = require('../../utils/demand');

const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_WINDOW_DAYS = 31;
const MAX_ITEM_LINES = 5000;

/**
 * The closed cafe-local days a sync may send: from lastSyncedThrough (or 7 days back) to the start of
 * today, at most 31 days per run. null when there is nothing new (workforce-integrations-21).
 */
const syncWindow = ({ timezone, lastSyncedThrough, now = new Date() }) => {
  const tz = safeTimezone(timezone);
  const todayStart = zonedDayStart(now, tz);
  const periodStart = lastSyncedThrough ? new Date(lastSyncedThrough) : addZonedDays(now, -DEFAULT_LOOKBACK_DAYS, tz);
  if (!(periodStart < todayStart)) return null;
  const cap = addZonedDays(periodStart, MAX_WINDOW_DAYS, tz);
  return { periodStart, periodEnd: cap < todayStart ? cap : todayStart, timezone: tz };
};

/** Totals and item lines computed in MongoDB, not by loading every transaction into Node. */
const buildSalesSummary = async ({ cafeId, cafeName, periodStart, periodEnd }) => {
  const match = {
    cafeId: new mongoose.Types.ObjectId(String(cafeId)),
    status: 'approved',
    date: { $gte: periodStart, $lt: periodEnd },
  };
  const [totals = {}] = await Transaction.aggregate([
    { $match: match },
    { $group: {
      _id: null,
      transactionCount: { $sum: 1 },
      totalRevenue: { $sum: { $ifNull: ['$total', 0] } },
      totalTip: { $sum: { $ifNull: ['$tip', 0] } },
    } },
  ]);
  const lines = await Transaction.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $group: {
      _id: { name: '$items.name', menuItemStatus: '$items.menuItemStatus' },
      amount: { $sum: { $multiply: [{ $ifNull: ['$items.unitPrice', 0] }, { $ifNull: ['$items.quantity', 0] }] } },
    } },
    { $sort: { amount: -1 } },
    { $limit: MAX_ITEM_LINES },
  ]);
  const breakdown = new Map();
  for (const { _id: line, amount } of lines) {
    if (!isDemandLine({ name: line.name, menuItemStatus: line.menuItemStatus })) continue;
    breakdown.set(line.name, (breakdown.get(line.name) || 0) + amount);
  }
  return {
    cafeName,
    periodStart,
    periodEnd,
    transactionCount: totals.transactionCount || 0,
    totalRevenue: totals.totalRevenue || 0,
    totalTip: totals.totalTip || 0,
    itemBreakdown: Object.fromEntries(breakdown),
  };
};

module.exports = { syncWindow, buildSalesSummary };
