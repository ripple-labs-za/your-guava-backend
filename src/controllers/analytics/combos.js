// GET /analytics/combos: bounded recent baskets and graceful older-Mongo sampling (BE-04-T04).
const mongoose = require('mongoose');
const Transaction = require('../../models/Transaction.model');
const { getCafeTimezone, buildDateMatch, analyticsRangeMeta } = require('./range');
const { activeCafeId } = require('../../utils/tenancy');
const { demandLines, demandItemsExpression } = require('../../utils/demand');

const { aggregateOptions, isQueryTimeout, queryTimeoutError, combosMaxBaskets,
  COMBO_MAX_ITEMS_PER_BASKET, MAX_COMBO_FALLBACK_TRANSACTIONS, MAX_COMBO_FALLBACK_PAIR_WORK,
} = require('../../services/analytics/limits');

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

    const maxBaskets = combosMaxBaskets();
    const [result] = await Transaction.aggregate([
      { $match: matchStage },
      { $match: { 'items.1': { $exists: true } } },
      // Most recent first; the index { cafeId, status, date: -1 } serves this sort.
      { $sort: { date: -1 } },
      { $limit: maxBaskets + 1 },
      {
        $facet: {
          baskets: [{ $count: 'n' }],
          pairs: [
            { $limit: maxBaskets },
            {
              $project: {
                itemNames: {
                  $slice: [{ $sortArray: { input: { $setUnion: [{ $map: { input: demandItemsExpression(), as: 'line', in: '$$line.name' } }, []] }, sortBy: 1 } }, COMBO_MAX_ITEMS_PER_BASKET],
                },
              },
            },
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

          ],
        },
      },
    ], aggregateOptions());

    const basketsSeen = result?.baskets?.[0]?.n || 0;
    return res.status(200).json({
      success: true,
      data: result?.pairs || [],
      meta: {
        ...analyticsRangeMeta(req.query, dateMatch, timezone),
        truncated: basketsSeen > maxBaskets,
        basketsConsidered: Math.min(basketsSeen, maxBaskets),
        maxBaskets,
        maxItemsPerBasket: COMBO_MAX_ITEMS_PER_BASKET,
      },
    });
  } catch (error) {
    if (error.message && error.message.includes('sortArray')) {
      try {
        const cafeId = activeCafeId(req);
        const timezone = await getCafeTimezone(cafeId);
        const dateMatch = buildDateMatch(req.query, timezone);
        const matchStage = { cafeId: new mongoose.Types.ObjectId(cafeId), status: 'approved', date: dateMatch };
        const cap = Math.min(combosMaxBaskets(), MAX_COMBO_FALLBACK_TRANSACTIONS);
        const transactions = await Transaction.find(
          { ...matchStage, 'items.1': { $exists: true } },
          null,
          aggregateOptions()
        )
          .select('items.name items.menuItemStatus')
          .sort({ date: -1, _id: -1 })
          .limit(cap + 1)
          .lean();

        let truncated = transactions.length > cap;
        let pairWork = 0;
        let basketsConsidered = 0;
        const pairCounts = new Map();
        for (const tx of transactions.slice(0, cap)) {
          const names = [...new Set(demandLines(tx.items).map((item) => item.name))].sort().slice(0, COMBO_MAX_ITEMS_PER_BASKET);
          const work = (names.length * (names.length - 1)) / 2;
          if (pairWork + work > MAX_COMBO_FALLBACK_PAIR_WORK) {
            truncated = true;
            break;
          }
          pairWork += work;
          basketsConsidered += 1;
          for (let i = 0; i < names.length; i += 1) {
            for (let j = i + 1; j < names.length; j += 1) {
              const key = JSON.stringify([names[i], names[j]]);
              pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
            }
          }
        }
        const combos = [...pairCounts]
          .map(([key, count]) => ({ pair: JSON.parse(key), count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        return res.status(200).json({
          success: true,
          data: combos,
          meta: {
            ...analyticsRangeMeta(req.query, dateMatch, timezone),
            truncated,
            basketsConsidered,
            maxBaskets: cap,
            maxItemsPerBasket: COMBO_MAX_ITEMS_PER_BASKET,
          },
        });
      } catch (fallbackError) {
        next(isQueryTimeout(fallbackError) ? queryTimeoutError() : fallbackError);
      }
    } else {
      next(isQueryTimeout(error) ? queryTimeoutError() : error);
    }
  }
};

module.exports = { getCombos };
