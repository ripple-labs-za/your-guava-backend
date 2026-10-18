const { rankMovers, itemTrend } = require('../../src/services/analytics/movers');

// { name: [previousWeekQty, currentWeekQty] }
const trendMapOf = (entries) => new Map(
  Object.entries(entries).map(([name, [previous, current]]) => [name, { previous, current }])
);

describe('rankMovers', () => {
  it('keeps a line that sold 14 last week and nothing this week as a full decline', () => {
    expect(rankMovers(trendMapOf({ Latte: [14, 0] })).decliningItems).toEqual([{ name: 'Latte', trend: -100 }]);
  });

  it('does not invent a new item or percentage from a negative refunded prior quantity', () => {
    const result = rankMovers(trendMapOf({ Latte: [-4, 20] }));
    expect(result.newItems).toEqual([]);
    expect(result.risingItems).toEqual([]);
    expect(result.decliningItems).toEqual([]);
    expect(itemTrend({ current: 20, previous: -4 })).toBeNull();
  });

  it('orders equal changes by volume and name, independent of input order', () => {
    const first = rankMovers(trendMapOf({ Zed: [20, 30], Tea: [40, 60], Apple: [20, 30] }));
    const reversed = rankMovers(trendMapOf({ Apple: [20, 30], Tea: [40, 60], Zed: [20, 30] }));
    expect(first.risingItems).toEqual([
      { name: 'Tea', trend: 50 }, { name: 'Apple', trend: 50 }, { name: 'Zed', trend: 50 },
    ]);
    expect(reversed).toEqual(first);
  });

  it('keeps items under 2 a day out of the movers, however large the percentage', () => {
    const result = rankMovers(trendMapOf({ Latte: [40, 52], Coke: [1, 8] }));
    expect(result.risingItems).toEqual([{ name: 'Latte', trend: 30 }]);
  });

  it('lists an item with no earlier sales as new, not as +100%', () => {
    const result = rankMovers(trendMapOf({ 'Iced Matcha': [0, 20], Scone: [0, 12] }));
    expect(result.newItems).toEqual([{ name: 'Iced Matcha', currentQty: 20 }]);
    expect(result.risingItems).toEqual([]);
  });

  it('ranks declines that carry volume and ignores small ones', () => {
    const result = rankMovers(trendMapOf({ Muffin: [42, 21], Brownie: [6, 2] }));
    expect(result.decliningItems).toEqual([{ name: 'Muffin', trend: -50 }]);
  });

  it('reports the floor and how close the busiest line came', () => {
    const { moverFloor } = rankMovers(trendMapOf({ Coke: [1, 8], Tea: [3, 9] }));
    expect(moverFloor).toEqual({ windowDays: 7, minQty: 14, eligibleCount: 0, belowFloorCount: 2, busiestQty: 9 });
  });

  it('treats exactly 14 in a week as enough', () => {
    expect(rankMovers(trendMapOf({ Latte: [7, 14] })).risingItems).toEqual([{ name: 'Latte', trend: 100 }]);
  });
});

describe('itemTrend', () => {
  it('is null when the earlier week had no sales', () => {
    expect(itemTrend({ current: 5, previous: 0 })).toBeNull();
  });

  it('is the percentage change otherwise', () => {
    expect(itemTrend({ current: 52, previous: 40 })).toBe(30);
  });
});

it('caps a refund-heavy current week at a complete decline', () => {
  expect(itemTrend({ previous: 20, current: -3 })).toBe(-100);
});

