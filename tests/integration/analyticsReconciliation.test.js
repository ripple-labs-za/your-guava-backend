const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');
const { buildBusinessContext } = require('../../src/services/anthropic.service');

const request = supertest(app);
const TZ = 'Africa/Johannesburg';

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

// Johannesburg has no daylight saving, so +02:00 is exact. 2026-03-02 is a Monday.
const row = (cafeId, day, time, total, paymentMethod, items, extra = {}) => ({
  cafeId,
  date: new Date(`${day}T${time}:00+02:00`),
  hour: Number(time.slice(0, 2)),
  dayOfWeek: new Date(`${day}T12:00:00Z`).getUTCDay(),
  status: 'approved',
  paymentMethod,
  items: items.map(([name, quantity, unitPrice]) => ({ name, quantity, unitPrice })),
  total,
  tip: 0,
  ...extra,
});

const seedWeek = (cafeId) => Transaction.insertMany([
  row(cafeId, '2026-03-02', '09:00', 100, 'Card', [['Flat White', 2, 50]]),
  row(cafeId, '2026-03-02', '10:00', 60, 'Cash', [['Muffin', 1, 60]], { tip: 10 }),
  row(cafeId, '2026-03-02', '11:00', 999, 'Card', [['Cake', 1, 999]], { status: 'declined' }),
  row(cafeId, '2026-03-03', '09:00', 80, 'SnapScan', [['Latte', 1, 80]]),
  // Wednesday 03-04: open by trading hours, no rows at all.
  row(cafeId, '2026-03-05', '09:00', 50, 'Credit Card', [['Flat White', 1, 50]]),
  row(cafeId, '2026-03-05', '15:00', -50, 'Credit Card', [['Flat White', -1, 50]]),
  row(cafeId, '2026-03-06', '09:00', 120, 'Cashless card', [['Latte', 3, 40]], { tip: 20 }),
  row(cafeId, '2026-03-06', '12:00', 0, 'Card', [['Water', 1, 0]]),
  row(cafeId, '2026-03-07', '09:00', 40, 'VISA', [['Muffin', 1, 40]]),
  row(cafeId, '2026-03-07', '10:00', 20, 'unknown', [['Cookie', 1, 20]]),
  // Sunday is closed by default trading hours, but this cafe traded.
  row(cafeId, '2026-03-08', '09:00', 30, 'Cash', [['Cookie', 1, 30]]),
]);

const WEEK = { startDate: '2026-03-02', endDate: '2026-03-08' };
const localDay = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

// Recomputed from raw documents in plain JavaScript. Nothing from src/ is used here on purpose.
const rawTotals = async (cafeId) => {
  const rows = await Transaction.find({
    cafeId,
    status: 'approved',
    date: { $gte: new Date('2026-03-02T00:00:00+02:00'), $lte: new Date('2026-03-08T23:59:59.999+02:00') },
  }).lean();
  const sales = rows.filter((r) => (r.total || 0) > 0);
  const refunds = rows.filter((r) => (r.total || 0) < 0);
  const netByDay = {};
  for (const r of rows) netByDay[localDay(r.date)] = (netByDay[localDay(r.date)] || 0) + (r.total || 0);
  return {
    net: rows.reduce((s, r) => s + (r.total || 0), 0),
    gross: sales.reduce((s, r) => s + r.total, 0),
    sales: sales.length,
    refunds: refunds.length,
    refundValue: -refunds.reduce((s, r) => s + r.total, 0),
    saleItems: sales.reduce((s, r) => s + r.items.reduce((a, i) => a + i.quantity, 0), 0),
    tipped: sales.filter((r) => (r.tip || 0) > 0).length,
    tips: sales.reduce((s, r) => s + (r.tip || 0), 0),
    netByDay,
  };
};

describe('analytics reconcile with the raw transactions', () => {
  let token;
  let cafeId;
  let owner;

  beforeEach(async () => {
    owner = await createTestUser();
    token = owner.token;
    cafeId = owner.user.activeCafeId;
  });

  const get = (path, query = WEEK) => request
    .get(`/api/analytics/${path}`)
    .set('Authorization', `Bearer ${token}`)
    .query(query);

  it('counts sales, not refunds or zero rows, and classifies tenders exactly', async () => {
    await seedWeek(cafeId);
    const raw = await rawTotals(cafeId);

    const { body } = await get('customers');
    const insights = body.insights;

    expect(insights.transactions).toBe(8); // Mon 2, Tue 1, Thu 1, Fri 1, Sat 2, Sun 1; the refund, the R0 row and the declined row are not sales
    expect(insights.transactions).toBe(raw.sales);
    expect(insights.avgTransactionValue).toBe(62.5); // 500 gross / 8 sales
    expect(insights.avgTransactionValue).toBe(raw.gross / raw.sales);
    expect(insights.avgItemsPerTransaction).toBe(1.4); // 11 items on sales / 8 = 1.375
    expect(insights.avgItemsPerTransaction).toBe(parseFloat((raw.saleItems / raw.sales).toFixed(1)));
    expect(insights.tippingRate).toBe(25); // 2 tipped sales / 8
    expect(insights.avgTip).toBe(15); // (10 + 20) / 2
    expect(insights.avgTip).toBe(raw.tips / raw.tipped);
    expect(insights.refunds).toEqual({ count: 1, value: 50 });
    expect(insights.refunds).toEqual({ count: raw.refunds, value: raw.refundValue });
    // Sales with a known tender: cash 2 (Mon, Sun), card 3 (Card, Credit Card, VISA), other 2 (SnapScan, Cashless card); 1 unknown.
    expect(insights.cashVsCardRatio).toEqual({ cash: 28.6, card: 42.9, other: 28.6 });
    expect(insights.paymentMethodCoverage).toEqual({ known: 7, unknown: 1 });
  });

  it('averages revenue over open days, including a zero-sale open day and a closed day that traded', async () => {
    await seedWeek(cafeId);
    const raw = await rawTotals(cafeId);

    const { body } = await get('revenue', { ...WEEK, period: 'daily' });

    expect(body.summary.totalRevenue).toBe(450); // 500 gross - 50 refund
    expect(body.summary.totalRevenue).toBe(raw.net);
    expect(body.summary.openDays).toBe(7); // Mon-Sat by trading hours + Sunday, which had a sale
    expect(body.summary.avgDailyRevenue).toBe(64.29); // 450 / 7
    expect(body.summary.bestDay).toEqual({ date: '2026-03-02', revenue: 160 });
    // Wednesday had no rows and Thursday netted to zero; the tie goes to the earlier day.
    expect(body.summary.worstDay).toEqual({ date: '2026-03-04', revenue: 0 });
    expect(body.data).toEqual([
      { date: '2026-03-02', revenue: 160, transactions: 2 },
      { date: '2026-03-03', revenue: 80, transactions: 1 },
      { date: '2026-03-05', revenue: 0, transactions: 1 },
      { date: '2026-03-06', revenue: 120, transactions: 1 },
      { date: '2026-03-07', revenue: 60, transactions: 2 },
      { date: '2026-03-08', revenue: 30, transactions: 1 },
    ]);
    for (const bucket of body.data) expect(bucket.revenue).toBe(raw.netByDay[bucket.date]);

    // analytics-ai-21: with weekly buckets the summary is still per open day, and best/worst are days, not weeks.
    const weekly = (await get('revenue', { ...WEEK, period: 'weekly' })).body;
    expect(weekly.data).toEqual([{ date: '2026-W10', revenue: 450, transactions: 8 }]); // Mon 2 to Sun 8 March is ISO week 10
    expect(weekly.summary.avgDailyRevenue).toBe(64.29);
    expect(weekly.summary.worstDay).toEqual({ date: '2026-03-04', revenue: 0 });
  });

  it('does not count a refund or a zero-total row as a visit on the heatmap', async () => {
    await seedWeek(cafeId);

    const { body } = await get('heatmap');
    const cell = (dayOfWeek, hour) => body.heatmap.find((c) => c.dayOfWeek === dayOfWeek && c.hour === hour);

    expect(cell(4, 15)).toEqual(expect.objectContaining({ totalRevenue: -50, totalTransactions: 0 }));
    expect(cell(5, 12)).toEqual(expect.objectContaining({ totalRevenue: 0, totalTransactions: 0 }));
    expect(cell(1, 9)).toEqual(expect.objectContaining({ totalRevenue: 100, totalTransactions: 1 }));
  });

  it('divides items per day by the days the cafe traded, not by the empty start of the range', async () => {
    // A cafe that started uploading on Sunday 1 March opens a 30-day window ending Saturday 7 March.
    const docs = [];
    for (let d = 1; d <= 7; d += 1) {
      const day = `2026-03-0${d}`;
      docs.push(row(cafeId, day, '09:00', 400, 'Card', [['Flat White', 10, 40]]));
    }
    await Transaction.insertMany(docs);

    const { body } = await get('items', { startDate: '2026-02-06', endDate: '2026-03-07' });

    expect(body.items[0]).toEqual(expect.objectContaining({ name: 'Flat White', totalQty: 70, avgPerDay: 10 }));
    expect(body.meta.observedSpan).toEqual({ startDate: '2026-03-01', endDate: '2026-03-07', openDays: 7 });
  });

  it('sums item quantities and revenue net of refunds', async () => {
    await seedWeek(cafeId);

    const { body } = await get('items');
    const byName = Object.fromEntries(body.items.map((item) => [item.name, item]));

    expect(byName['Flat White']).toEqual(expect.objectContaining({ totalQty: 2, totalRevenue: 100, avgPerDay: 0.3 })); // 2+1-1 over 7 open days
    expect(byName.Latte).toEqual(expect.objectContaining({ totalQty: 4, totalRevenue: 200, avgPerDay: 0.6 }));
    expect(byName.Cake).toBeUndefined(); // declined
  });

  it('gives the AI the same transaction count and basket as Performance', async () => {
    const recent = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await Transaction.insertMany([
      { cafeId, date: recent(2), hour: 9, dayOfWeek: recent(2).getUTCDay(), status: 'approved', items: [{ name: 'Flat White', quantity: 1, unitPrice: 50 }], total: 50 },
      { cafeId, date: recent(2), hour: 10, dayOfWeek: recent(2).getUTCDay(), status: 'approved', items: [{ name: 'Flat White', quantity: 1, unitPrice: 50 }], total: 50 },
        { cafeId, date: recent(2), hour: 9, dayOfWeek: recent(2).getUTCDay(), status: 'approved', items: [{ name: 'Flat White', quantity: -1, unitPrice: 50 }], total: -50 },
    ]);

    const context = await buildBusinessContext({
      cafeId,
      orgId: owner.user.orgId,
      authorizedCafeIds: [cafeId],
    });

    expect(context.dataset.transactionCount).toBe(2);
    expect(context.dataset.avgBasket).toBe(50);
    expect(context.dataset.totalRevenue).toBe(50);
    expect(context.dayOfWeekPattern90d.find((entry) => entry.transactions > 0).avgRevenuePerTransaction)
      .toBe(context.dataset.avgBasket);
  });

  it('reports zero items per open day when a closed Sunday has only a refund', async () => {
    await Transaction.create(row(cafeId, '2026-03-08', '15:00', -50, 'Card', [['Flat White', -1, 50]]));
    const { body } = await get('items', { startDate: '2026-03-08', endDate: '2026-03-08' });
    expect(body.meta.observedSpan.openDays).toBe(0);
    expect(body.items[0].avgPerDay).toBe(0);
  });

  it('reports refunds without inventing visits or dividing by zero in a refund-only range', async () => {
    await Transaction.create(row(cafeId, '2026-03-05', '15:00', -50, 'Card', [['Flat White', -1, 50]]));
    const { body } = await get('customers');
    expect(body.insights).toEqual(expect.objectContaining({
      transactions: 0, avgTransactionValue: 0, avgItemsPerTransaction: 0,
      cashVsCardRatio: null, paymentMethodCoverage: { known: 0, unknown: 0 },
      refunds: { count: 1, value: 50 }, tippingRate: 0, avgTip: 0,
    }));
  });

  it('does not count legacy null or missing totals as sales or refunds', async () => {
    const docs = [
      row(cafeId, '2026-03-05', '10:00', null, 'Card', [['Water', 1, 0]]),
      row(cafeId, '2026-03-05', '11:00', 0, 'Cash', [['Water', 1, 0]]),
    ];
    delete docs[1].total;
    await Transaction.collection.insertMany(docs);
    const { body } = await get('customers');
    expect(body.insights.transactions).toBe(0);
    expect(body.insights.refunds).toEqual({ count: 0, value: 0 });
    expect(body.insights.avgTransactionValue).toBe(0);
    expect(body.insights.cashVsCardRatio).toBeNull();
  });

  it('uses the exact same tender classification for inner spaces and nonbreaking spaces', async () => {
    const { classifyTender } = require('../../src/services/analytics/semantics');
    const tenders = ['credit  card', 'credit\u00a0card', '\u00a0Card\u00a0'];
    expect(tenders.map(classifyTender)).toEqual(['other', 'other', 'card']);
    await Transaction.insertMany(tenders.map((tender, i) =>
      row(cafeId, '2026-03-05', `${10 + i}:00`, 50, tender, [['Flat White', 1, 50]])));
    const { body } = await get('customers');
    expect(body.insights.cashVsCardRatio).toEqual({ cash: 0, card: 33.3, other: 66.7 });
    expect(body.insights.paymentMethodCoverage).toEqual({ known: 3, unknown: 0 });
  });
});
