// GET /analytics/customers.
// Moved from analytics.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const { saleCount, refundCount, grossSales, refundValue, IS_SALE, tenderExpression } = require('../../services/analytics/semantics');
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

    const tenderSales = (tender) => ({ $sum: { $cond: [{ $and: [IS_SALE, { $eq: ['$_tender', tender] }] }, 1, 0] } });
    const pipeline = [
      { $match: matchStage },
      { $addFields: { _tender: tenderExpression } },
      {
        $group: {
          _id: null,
          sales: saleCount,
          refunds: refundCount,
          grossSales,
          refundValue,
          saleItems: {
            $sum: {
              $cond: [IS_SALE, { $reduce: { input: demandItemsExpression(), initialValue: 0, in: { $add: ['$$value', '$$this.quantity'] } } }, 0],
            },
          },
          saleTips: { $sum: { $cond: [IS_SALE, { $ifNull: ['$tip', 0] }, 0] } },
          tippedSales: { $sum: { $cond: [{ $and: [IS_SALE, { $gt: [{ $ifNull: ['$tip', 0] }, 0] }] }, 1, 0] } },
          cashSales: tenderSales('cash'),
          cardSales: tenderSales('card'),
          otherSales: tenderSales('other'),
          unknownTenderSales: tenderSales('unknown'),
        },
      },
    ];
    const [stats] = await Transaction.aggregate(pipeline);
    const s = stats || {
      sales: 0, refunds: 0, grossSales: 0, refundValue: 0, saleItems: 0, saleTips: 0, tippedSales: 0,
      cashSales: 0, cardSales: 0, otherSales: 0, unknownTenderSales: 0,
    };
    const pct = (part, whole) => parseFloat(((part / whole) * 100).toFixed(1));
    const known = s.cashSales + s.cardSales + s.otherSales;
    const insights = {
      transactions: s.sales,
      avgTransactionValue: s.sales > 0 ? parseFloat((s.grossSales / s.sales).toFixed(2)) : 0,
      avgItemsPerTransaction: s.sales > 0 ? parseFloat((s.saleItems / s.sales).toFixed(1)) : 0,
      cashVsCardRatio: known > 0
        ? { cash: pct(s.cashSales, known), card: pct(s.cardSales, known), other: pct(s.otherSales, known) }
        : null,
      paymentMethodCoverage: { known, unknown: s.unknownTenderSales },
      tippingRate: s.sales > 0 ? pct(s.tippedSales, s.sales) : 0,
      avgTip: s.tippedSales > 0 ? parseFloat((s.saleTips / s.tippedSales).toFixed(2)) : 0,
      refunds: { count: s.refunds, value: parseFloat((-s.refundValue).toFixed(2)) || 0 },
    };
    return res.status(200).json({ success: true, insights, data: insights, meta: analyticsRangeMeta(req.query, dateMatch, timezone) });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCustomers,
};
