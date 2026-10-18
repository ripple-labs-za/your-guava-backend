// Movers compare the latest 7 days with the 7 before. A percentage only means something when the line sells: an item
// that went from 1 to 8 is "+700%" and would crowd out the lines that matter. The floor is 14 units in either week.
const MOVER_MIN_QTY_PER_WEEK = 14;
const MOVER_WINDOW_DAYS = 7;
const MOVER_MIN_QTY = MOVER_MIN_QTY_PER_WEEK;
const MOVER_LIMIT = 5;

// null, not 100: with nothing sold in the earlier week there is no percentage to report (the item is new).
const itemTrend = ({ current = 0, previous = 0 }) => (
  previous > 0 ? parseFloat((((Math.max(current, 0) - previous) / previous) * 100).toFixed(1)) || 0 : null
);

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * @param {Map<string, { current: number, previous: number }>} trendMap item quantities in the latest and the previous 7 days
 */
const rankMovers = (trendMap) => {
  const rows = [...trendMap].map(([name, qty]) => ({
    name,
    currentQty: qty.current || 0,
    previousQty: qty.previous || 0,
  }));
  const busiestQty = rows.reduce((max, row) => Math.max(max, row.currentQty, row.previousQty), 0);
  const eligible = rows.filter((row) => Math.max(row.currentQty, row.previousQty) >= MOVER_MIN_QTY);
  const compared = eligible
    .filter((row) => row.previousQty > 0)
    .map((row) => ({ ...row, trend: itemTrend({ current: row.currentQty, previous: row.previousQty }) }));

  const risingItems = compared
    .filter((row) => row.trend > 0)
    .sort((a, b) => b.trend - a.trend || b.currentQty - a.currentQty || byName(a, b))
    .slice(0, MOVER_LIMIT)
    .map(({ name, trend }) => ({ name, trend }));
  const decliningItems = compared
    .filter((row) => row.trend < 0)
    .sort((a, b) => a.trend - b.trend || b.previousQty - a.previousQty || byName(a, b))
    .slice(0, MOVER_LIMIT)
    .map(({ name, trend }) => ({ name, trend }));
  const newItems = eligible
    .filter((row) => row.previousQty === 0 && row.currentQty > 0)
    .sort((a, b) => b.currentQty - a.currentQty || byName(a, b))
    .slice(0, MOVER_LIMIT)
    .map(({ name, currentQty }) => ({ name, currentQty }));

  return {
    risingItems,
    decliningItems,
    newItems,
    moverFloor: {
      windowDays: MOVER_WINDOW_DAYS,
      minQty: MOVER_MIN_QTY,
      eligibleCount: eligible.length,
      belowFloorCount: rows.length - eligible.length,
      busiestQty,
    },
  };
};

module.exports = { MOVER_MIN_QTY_PER_WEEK, MOVER_WINDOW_DAYS, itemTrend, rankMovers };
