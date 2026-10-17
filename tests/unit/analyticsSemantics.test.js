const {
  TENDER_GROUPS,
  classifyTender,
  isSaleRow,
  isRefundRow,
} = require('../../src/services/analytics/semantics');
const { openDaysBetween, dailySummary } = require('../../src/services/analytics/windows');

// The default week from utils/tradingHours: Monday to Saturday open, Sunday closed.
const DEFAULT_HOURS = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, isOpen: dayOfWeek !== 0 }));

describe('classifyTender', () => {
  it.each([
    ['Cash', 'cash'],
    [' cash ', 'cash'],
    ['Card', 'card'],
    ['Credit Card', 'card'],
    ['VISA', 'card'],
    ['Apple Pay', 'card'],
    ['Cashless card', 'other'],
    ['Card (cashback)', 'other'],
    ['Cash & Card', 'other'],
    ['SnapScan', 'other'],
    ['EFT', 'other'],
    ['', 'unknown'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['unknown', 'unknown'],
    ['N/A', 'unknown'],
  ])('classifies %p as %s', (value, expected) => {
    expect(classifyTender(value)).toBe(expected);
  });

  it('never lists one value under two tenders', () => {
    const all = [...TENDER_GROUPS.cash, ...TENDER_GROUPS.card, ...TENDER_GROUPS.unknown];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('sale and refund rows', () => {
  it('counts positive totals as sales and negative totals as refunds, and nothing else', () => {
    expect(isSaleRow({ total: 50 })).toBe(true);
    expect(isRefundRow({ total: -50 })).toBe(true);
    for (const total of [0, null, undefined]) {
      expect(isSaleRow({ total })).toBe(false);
      expect(isRefundRow({ total })).toBe(false);
    }
  });
});

describe('openDaysBetween', () => {
  it('counts open weekdays, skips closed ones, and keeps a closed day that traded', () => {
    // 2026-03-02 is a Monday; Sunday 2026-03-08 is closed by default.
    const traded = openDaysBetween({
      fromDate: '2026-03-02', toDate: '2026-03-08', tradingHours: DEFAULT_HOURS, saleDays: new Set(['2026-03-08']),
    });
    expect(traded).toEqual([
      '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08',
    ]);
    expect(openDaysBetween({
      fromDate: '2026-03-02', toDate: '2026-03-08', tradingHours: DEFAULT_HOURS, saleDays: new Set(),
    })).toHaveLength(6);
  });
});

describe('dailySummary', () => {
  it('finds the worst day among zero-sale open days, the earliest on a tie', () => {
    const daily = [
      { _id: '2026-03-02', revenue: 160, transactions: 2 },
      { _id: '2026-03-05', revenue: 0, transactions: 1 },
    ];
    expect(dailySummary({ daily, tradingHours: DEFAULT_HOURS })).toEqual({
      openDays: 4,
      bestDay: { date: '2026-03-02', revenue: 160 },
      worstDay: { date: '2026-03-03', revenue: 0 },
    });
  });

  it('has no best or worst day for an empty range', () => {
    expect(dailySummary({ daily: [], tradingHours: DEFAULT_HOURS })).toEqual({ openDays: 0, bestDay: null, worstDay: null });
  });
});
