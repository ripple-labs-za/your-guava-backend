// GET /analytics/combos, with its fallback bounds.
// Moved from analytics.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const Transaction = require('../../models/Transaction.model');
const { getCafeTimezone, buildDateMatch, analyticsRangeMeta } = require('./range');
const { activeCafeId } = require('../../utils/tenancy');
const { demandLines, demandItemsExpression } = require('../../utils/demand');

const MAX_COMBO_FALLBACK_TRANSACTIONS = 5000;
const MAX_COMBO_FALLBACK_PAIR_WORK = 100000;

/**
 * GET /api/analytics/combos
 * Frequently-bought-together item pairs
 */
const getCombos = async (req, res, next) => {
  try {
    const cafeId = activeCafeId(req);
    const timezone = await getCafeTimezone(cafeId);
    const dateMatch = buildDateMatch(req.query, timezone);

    const matchStage = {
      cafeId: new mongoose.Types.ObjectId(cafeId),
      status: 'approved',
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };

    // Take the top 20 item-pair co-occurrences across all transactions with 2+ items.
    const combos = await Transaction.aggregate([
      { $match: matchStage },
      { $match: { 'items.1': { $exists: true } } },           // ≥2 items
      {
        $project: {
          // Ignored lines (a delivery fee) are not part of what was bought together (BE-03-T11).
          itemNames: {
            $sortArray: {
              input: { $setUnion: [{ $map: { input: demandItemsExpression(), as: 'line', in: '$$line.name' } }, []] },
              sortBy: 1,
            },
          },
        },
      },
      { $match: { 'itemNames.1': { $exists: true } } },
      // Generate unordered pairs
      {
        $project: {
          pairs: {
            $reduce: {
              input: { $range: [0, { $size: '$itemNames' }] },
              initialValue: [],
              in: {
                $concatArrays: [
                  '$$value',
                  {
                    $map: {
                      input: { $range: [{ $add: ['$$this', 1] }, { $size: '$itemNames' }] },
                      as: 'j',
                      in: [
                        { $arrayElemAt: ['$itemNames', '$$this'] },
                        { $arrayElemAt: ['$itemNames', '$$j'] },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
      { $unwind: '$pairs' },
      { $group: { _id: '$pairs', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          pair: '$_id',
          count: 1,
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: combos,
      meta: analyticsRangeMeta(req.query, dateMatch),
    });
  } catch (error) {
    // If $sortArray is not available (older MongoDB), fall back to JS-side pair generation
    if (error.message && error.message.includes('sortArray')) {
      try {
        const cafeId = activeCafeId(req);
        const timezone = await getCafeTimezone(cafeId);
        const dateMatch = buildDateMatch(req.query, timezone);

        const matchStage = {
          cafeId: new mongoose.Types.ObjectId(cafeId),
          status: 'approved',
          ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
        };

        const transactions = await Transaction.find({
          ...matchStage,
          'items.1': { $exists: true },
        })
          .select('items.name items.menuItemStatus')
          .sort({ date: -1, _id: -1 })
          .limit(MAX_COMBO_FALLBACK_TRANSACTIONS + 1)
          .lean();

        if (transactions.length > MAX_COMBO_FALLBACK_TRANSACTIONS) {
          const capacityError = new Error(
            `Combo analytics fallback is limited to ${MAX_COMBO_FALLBACK_TRANSACTIONS} transactions; narrow the date range`
          );
          capacityError.statusCode = 503;
          capacityError.details = { code: 'COMBO_FALLBACK_RANGE_TOO_LARGE' };
          throw capacityError;
        }

        const pairCounts = {};
        let pairWork = 0;
        for (const tx of transactions) {
          const names = [...new Set(demandLines(tx.items).map((i) => i.name))].sort();
          if (names.length < 2) continue;
          pairWork += (names.length * (names.length - 1)) / 2;
          if (pairWork > MAX_COMBO_FALLBACK_PAIR_WORK) {
            const capacityError = new Error(
              `Combo analytics fallback exceeds its ${MAX_COMBO_FALLBACK_PAIR_WORK}-pair work budget; narrow the date range`
            );
            capacityError.statusCode = 503;
            capacityError.details = { code: 'COMBO_FALLBACK_WORK_LIMIT' };
            throw capacityError;
          }
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              const key = JSON.stringify([names[i], names[j]]);
              pairCounts[key] = (pairCounts[key] || 0) + 1;
            }
          }
        }

        const combos = Object.entries(pairCounts)
          .map(([key, count]) => ({ pair: JSON.parse(key), count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        return res.status(200).json({
          success: true,
          data: combos,
          meta: analyticsRangeMeta(req.query, dateMatch),
        });
      } catch (fallbackError) {
        next(fallbackError);
      }
    } else {
      next(error);
    }
  }
};

module.exports = {
  getCombos,
};
