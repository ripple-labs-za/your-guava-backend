// GET /analytics/customers.
// Moved from analytics.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const Transaction = require('../../models/Transaction.model');
const { getCafeTimezone, buildDateMatch, analyticsRangeMeta } = require('./range');
const { activeCafeId } = require('../../utils/tenancy');
const { demandItemsExpression } = require('../../utils/demand');

/**
 * GET /api/analytics/customers
 * Customer insights from transaction data
 */
const getCustomers = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);
    const timezone = await getCafeTimezone(cafeId);

    const dateMatch = buildDateMatch(req.query, timezone);
    const matchStage = {
      cafeId: cafeObjectId,
      status: 'approved',
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };

    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalRevenue: { $sum: '$total' },
          totalItems: {
            $sum: {
              $reduce: {
                input: demandItemsExpression(),
                initialValue: 0,
                in: { $add: ['$$value', '$$this.quantity'] },
              },
            },
          },
          totalTip: { $sum: { $ifNull: ['$tip', 0] } },
          tippedTransactions: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ['$tip', 0] }, 0] }, 1, 0],
            },
          },
          cashTransactions: {
            $sum: {
              $cond: [
                {
                  $regexMatch: {
                    input: { $ifNull: ['$paymentMethod', ''] },
                    regex: /cash/i,
                  },
                },
                1,
                0,
              ],
            },
          },
          cardTransactions: {
            $sum: {
              $cond: [
                {
                  $regexMatch: {
                    input: { $ifNull: ['$paymentMethod', ''] },
                    regex: /card|visa|master|tap|contactless/i,
                  },
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ];

    const result = await Transaction.aggregate(pipeline);

    if (result.length === 0) {
      const emptyInsights = {
        avgTransactionValue: 0,
        avgItemsPerTransaction: 0,
        cashVsCardRatio: null,
        tippingRate: 0,
        avgTip: 0,
      };
      return res.status(200).json({
        success: true,
        insights: emptyInsights,
        data: emptyInsights,
        meta: analyticsRangeMeta(req.query, dateMatch, timezone),
      });
    }

    const stats = result[0];
    const avgTransactionValue =
      stats.totalTransactions > 0
        ? parseFloat((stats.totalRevenue / stats.totalTransactions).toFixed(2))
        : 0;

    const avgItemsPerTransaction =
      stats.totalTransactions > 0
        ? parseFloat((stats.totalItems / stats.totalTransactions).toFixed(1))
        : 0;

    const totalPaymentKnown = stats.cashTransactions + stats.cardTransactions;
    const cashVsCardRatio =
      totalPaymentKnown > 0
        ? {
            cash: parseFloat(((stats.cashTransactions / totalPaymentKnown) * 100).toFixed(1)),
            card: parseFloat(((stats.cardTransactions / totalPaymentKnown) * 100).toFixed(1)),
          }
        : null;

    const tippingRate =
      stats.totalTransactions > 0
        ? parseFloat(((stats.tippedTransactions / stats.totalTransactions) * 100).toFixed(1))
        : 0;

    const avgTip =
      stats.tippedTransactions > 0
        ? parseFloat((stats.totalTip / stats.tippedTransactions).toFixed(2))
        : 0;

    const insights = {
      avgTransactionValue,
      avgItemsPerTransaction,
      cashVsCardRatio,
      tippingRate,
      avgTip,
    };

    return res.status(200).json({
      success: true,
      insights,
      data: insights,
      meta: analyticsRangeMeta(req.query, dateMatch, timezone),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCustomers,
};
