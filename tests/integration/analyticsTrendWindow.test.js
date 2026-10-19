const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);
const TZ = 'Africa/Johannesburg';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const localKey = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const shift = (key, days) => new Date(Date.parse(`${key}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
// Johannesburg has no daylight saving, so +02:00 is exact all year.
const at = (key, time = '10:00') => new Date(`${key}T${time}:00+02:00`);
const weekday = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();

const flatDay = (cafeId, key, total = 5000) => ({
  cafeId,
  date: at(key),
  hour: 10,
  dayOfWeek: weekday(key),
  status: 'approved',
  items: [{ name: 'Flat White', quantity: 100, unitPrice: total / 100 }],
  total,
});

describe('GET /api/analytics/revenue trend window', () => {
  let token;
  let cafeId;
  let today;

  beforeEach(async () => {
    const owner = await createTestUser();
    token = owner.token;
    cafeId = owner.user.activeCafeId;
    today = localKey(new Date());
  });

  const revenueFor = (days) => request
    .get('/api/analytics/revenue')
    .set('Authorization', `Bearer ${token}`)
    .query({ period: 'daily', startDate: shift(today, -(days - 1)), endDate: today });

  const seedFlatHistory = (fromDaysAgo, toDaysAgo) => {
    const docs = [];
    for (let ago = fromDaysAgo; ago >= toDaysAgo; ago -= 1) docs.push(flatDay(cafeId, shift(today, -ago)));
    return Transaction.insertMany(docs);
  };

  it.each([7, 30, 90])('shows a 0%% trend for flat sales on the %id view when today has no data yet', async (days) => {
    await seedFlatHistory(200, 1);

    const res = await revenueFor(days);

    expect(res.status).toBe(200);
    expect(res.body.summary.trend).toBe(0);
    expect(res.body.meta.effectiveWindow).toEqual(expect.objectContaining({
      startDate: shift(today, -(days - 1)),
      endDate: shift(today, -1),
      days: days - 1,
      endReason: 'today_incomplete',
      revenue: 5000 * (days - 1),
    }));
    expect(res.body.meta.comparisonWindow).toEqual(expect.objectContaining({
      startDate: shift(today, -(2 * days - 2)),
      endDate: shift(today, -days),
      days: days - 1,
      revenue: 5000 * (days - 1),
    }));
    expect(res.body.meta.trendReason).toBeNull();
  });

  it.each([7, 30, 90])('shows a 0%% trend on the %id view while today is still trading', async (days) => {
    await seedFlatHistory(200, 1);
    const todayStart = at(today, '00:00').getTime();
    await Transaction.create({
      ...flatDay(cafeId, today, 1200),
      date: new Date(Math.max(todayStart + 1000, Date.now() - 60 * 1000)),
    });

    const res = await revenueFor(days);

    expect(res.body.summary.trend).toBe(0);
    // The total still includes today's takings; only the comparison leaves the unfinished day out.
    expect(res.body.summary.totalRevenue).toBe(5000 * (days - 1) + 1200);
    expect(res.body.meta.effectiveWindow.endDate).toBe(shift(today, -1));
  });

  it('ends the comparison at the last day with data when uploads are behind', async () => {
    await seedFlatHistory(200, 3);

    const res = await revenueFor(7);

    expect(res.body.summary.trend).toBe(0);
    expect(res.body.meta.effectiveWindow).toEqual(expect.objectContaining({
      startDate: shift(today, -6), endDate: shift(today, -3), days: 4, endReason: 'data_ends',
    }));
    expect(res.body.meta.comparisonWindow).toEqual(expect.objectContaining({
      startDate: shift(today, -10), endDate: shift(today, -7), days: 4,
    }));
  });

  it('reports no trend, and why, when history does not reach the comparison window', async () => {
    await seedFlatHistory(10, 1);

    const res = await revenueFor(30);

    expect(res.body.summary.trend).toBeNull();
    expect(res.body.meta.trendReason).toBe('insufficient_history');
  });

  it('states the queried window as cafe-local days on every analytics endpoint', async () => {
    const query = { startDate: shift(today, -29), endDate: today };
    const responses = await Promise.all(['revenue', 'items', 'heatmap', 'customers', 'combos'].map((path) => request
      .get(`/api/analytics/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .query(query)));

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual(expect.objectContaining({
        timezone: TZ,
        effectiveStartDay: shift(today, -29),
        effectiveEndDay: today,
        effectiveDays: 30,
      }));
    }
  });

  it('counts a 23:30 New York sale on its local day across the daylight-saving boundary', async () => {
    const Cafe = require('../../src/models/Cafe.model');
    await Cafe.findByIdAndUpdate(cafeId, { timezone: 'America/New_York' });
    await Transaction.insertMany([
      { ...flatDay(cafeId, '2026-03-07', 5000), date: new Date('2026-03-07T23:30:00-05:00') },
      { ...flatDay(cafeId, '2026-03-08', 5000), date: new Date('2026-03-08T23:30:00-04:00') },
    ]);
    const res = await request.get('/api/analytics/revenue')
      .set('Authorization', `Bearer ${token}`)
      .query({ startDate: '2026-03-08', endDate: '2026-03-08' });
    expect(res.status).toBe(200);
    expect(res.body.summary.trend).toBe(0);
    expect(res.body.meta.effectiveWindow).toEqual(expect.objectContaining({
      startDate: '2026-03-08', endDate: '2026-03-08', days: 1,
      start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T03:59:59.999Z', revenue: 5000,
    }));
    expect(res.body.meta.comparisonWindow.revenue).toBe(5000);
    expect(res.body.meta.timezone).toBe('America/New_York');
  });

  it.each([7, 30, 90])('keeps a scheduled closed yesterday in the complete %i-day comparison', async (days) => {
    const Cafe = require('../../src/models/Cafe.model');
    const closedDay = weekday(shift(today, -1));
    await Cafe.findByIdAndUpdate(cafeId, { tradingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek, isOpen: dayOfWeek !== closedDay, openTime: '07:00', closeTime: '17:00',
    })) });
    const docs = [];
    for (let ago = 200; ago >= 1; ago -= 1) {
      const day = shift(today, -ago);
      if (weekday(day) !== closedDay) docs.push(flatDay(cafeId, day));
    }
    await Transaction.insertMany(docs);
    const res = await revenueFor(days);
    const currentStart = shift(today, -(days - 1));
    const previousStart = shift(today, -(2 * days - 2));
    const previousEnd = shift(today, -days);
    const current = docs.filter((doc) => localKey(doc.date) >= currentStart).reduce((sum, doc) => sum + doc.total, 0);
    const previous = docs.filter((doc) => localKey(doc.date) >= previousStart && localKey(doc.date) <= previousEnd)
      .reduce((sum, doc) => sum + doc.total, 0);
    // Equal calendar spans retain real weekday mix effects: the 29-day spans can have 24 vs 25 open days.
    expect(res.body.summary.trend).toBe(Number((((current - previous) / previous) * 100).toFixed(1)) || 0);
    if (days === 7 || days === 90) expect(res.body.summary.trend).toBe(0); // static-checks: allow conditional-expect it.each row: only the 7- and 90-day spans always hold equal open days
    expect(res.body.meta.effectiveWindow.endDate).toBe(shift(today, -1));
    expect(res.body.meta.effectiveWindow.endReason).toBe('today_incomplete');
  });

  it.each([0, -5000])('declines to calculate a percentage from previous net revenue %i', async (previous) => {
    await Transaction.insertMany([
      flatDay(cafeId, '2026-01-01', previous),
      flatDay(cafeId, '2026-01-02', 5000),
    ]);
    const res = await request.get('/api/analytics/revenue')
      .set('Authorization', `Bearer ${token}`)
      .query({ startDate: '2026-01-02', endDate: '2026-01-02' });
    expect(res.status).toBe(200);
    expect(res.body.summary.trend).toBeNull();
    expect(res.body.meta.trendReason).toBe('no_previous_revenue');
    expect(res.body.meta.comparisonWindow.revenue).toBe(previous);
  });

  it('clamps a timed effective start so its revenue agrees with the requested total', async () => {
    const docs = [flatDay(cafeId, '2026-01-01', 1000)];
    for (let day = 6; day <= 13; day += 1) docs.push(flatDay(cafeId, `2026-02-${String(day).padStart(2, '0')}`, 1000));
    docs.push({ ...flatDay(cafeId, '2026-02-10', 1000), date: at('2026-02-10', '14:00') });
    await Transaction.insertMany(docs);
    const res = await request.get('/api/analytics/revenue').set('Authorization', `Bearer ${token}`)
      .query({ startDate: '2026-02-10T12:00:00+02:00', endDate: '2026-02-13' });
    expect(res.body.meta.effectiveWindow.start).toBe('2026-02-10T10:00:00.000Z');
    expect(res.body.meta.effectiveWindow.revenue).toBe(4000);
    expect(res.body.summary.totalRevenue).toBe(4000);
    expect(res.body.summary.trend).toBe(0);
  });
});
